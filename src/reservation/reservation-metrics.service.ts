import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import Redis from 'ioredis';
import { Counter, Gauge, Histogram } from 'prom-client';
import {
  RESERVATION_CONSUMER_GROUP,
  RESERVATION_DLQ_STREAM,
  RESERVATION_STREAM,
} from './test-run-tracker.service';

export type ReservationRequestOutcome =
  | 'accepted'
  | 'expected_conflict'
  | 'unexpected_failure';

export type ReservationLuaResult =
  | 'OK'
  | 'FAIL'
  | 'MISS'
  | 'WAIT'
  | 'ERROR'
  | 'UNKNOWN';

type StreamGroupRow = Array<string | number>;
type PendingRow = [string, string, number, number];
type StreamEntry = [string, string[]];

@Injectable()
export class ReservationMetricsService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ReservationMetricsService.name);
  private refreshTimer?: NodeJS.Timeout;
  private collectionHealthy?: boolean;

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @InjectMetric('reservation_request_outcome_total')
    private readonly requestOutcomeCounter: Counter<'outcome'>,
    @InjectMetric('reservation_lua_result_total')
    private readonly luaResultCounter: Counter<'result'>,
    @InjectMetric('reservation_queue_total')
    private readonly enqueueCounter: Counter<'status'>,
    @InjectMetric('reservation_processed_total')
    private readonly processedCounter: Counter<'status'>,
    @InjectMetric('reservation_persistence_latency_seconds')
    private readonly persistenceLatency: Histogram<string>,
    @InjectMetric('reservation_scheduler_batch_size')
    private readonly schedulerBatchSize: Histogram<string>,
    @InjectMetric('reservation_scheduler_batch_duration_seconds')
    private readonly schedulerBatchDuration: Histogram<string>,
    @InjectMetric('reservation_queue_depth_messages')
    private readonly queueDepth: Gauge<string>,
    @InjectMetric('reservation_queue_processing_messages')
    private readonly queueProcessing: Gauge<string>,
    @InjectMetric('reservation_queue_retry_messages')
    private readonly queueRetry: Gauge<string>,
    @InjectMetric('reservation_queue_dlq_messages')
    private readonly queueDlq: Gauge<string>,
    @InjectMetric('reservation_queue_oldest_message_age_seconds')
    private readonly queueOldestAge: Gauge<string>,
    @InjectMetric('reservation_queue_metrics_collection_up')
    private readonly queueCollectionUp: Gauge<string>,
    @InjectMetric('reservation_queue_retry_scan_complete')
    private readonly retryScanComplete: Gauge<string>,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const outcome of [
      'accepted',
      'expected_conflict',
      'unexpected_failure',
    ] as const) {
      this.requestOutcomeCounter.labels(outcome).inc(0);
    }
    for (const result of [
      'OK',
      'FAIL',
      'MISS',
      'WAIT',
      'ERROR',
      'UNKNOWN',
    ] as const) {
      this.luaResultCounter.labels(result).inc(0);
    }
    for (const status of ['success', 'fail'] as const) {
      this.enqueueCounter.labels(status).inc(0);
      this.processedCounter.labels(status).inc(0);
    }
    await this.refreshQueueMetrics();
    this.refreshTimer = setInterval(
      () => void this.refreshQueueMetrics(),
      this.refreshIntervalMs(),
    );
    this.refreshTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  recordRequestOutcome(outcome: ReservationRequestOutcome): void {
    this.requestOutcomeCounter.labels(outcome).inc();
  }

  recordLuaResult(result: ReservationLuaResult, count = 1): void {
    this.luaResultCounter.labels(result).inc(count);
  }

  observePersistenceLatency(streamId: string, now = Date.now()): void {
    const enqueuedAt = Number(streamId.split('-', 1)[0]);
    if (
      !Number.isSafeInteger(enqueuedAt) ||
      enqueuedAt <= 0 ||
      enqueuedAt > now
    ) {
      return;
    }
    this.persistenceLatency.observe((now - enqueuedAt) / 1000);
  }

  observeSchedulerBatch(processed: number, durationSeconds: number): void {
    this.schedulerBatchSize.observe(processed);
    this.schedulerBatchDuration.observe(Math.max(durationSeconds, 0));
  }

  async refreshQueueMetrics(now = Date.now()): Promise<void> {
    try {
      const [depth, dlq, oldest] = await Promise.all([
        this.redis.xlen(RESERVATION_STREAM),
        this.redis.xlen(RESERVATION_DLQ_STREAM),
        this.redis.xrange(RESERVATION_STREAM, '-', '+', 'COUNT', 1) as Promise<
          StreamEntry[]
        >,
      ]);
      const { processing, retry, complete } = await this.pendingState();
      const oldestTimestamp = Number(oldest[0]?.[0]?.split('-', 1)[0] || now);
      const oldestAge =
        depth > 0 && Number.isSafeInteger(oldestTimestamp)
          ? Math.max(0, (now - oldestTimestamp) / 1000)
          : 0;

      this.queueDepth.set(Number(depth));
      this.queueProcessing.set(processing);
      this.queueRetry.set(retry);
      this.queueDlq.set(Number(dlq));
      this.queueOldestAge.set(oldestAge);
      this.retryScanComplete.set(complete ? 1 : 0);
      this.queueCollectionUp.set(1);
      if (this.collectionHealthy === false) {
        this.logger.log('Reservation queue metric collection recovered');
      }
      this.collectionHealthy = true;
    } catch {
      this.queueCollectionUp.set(0);
      if (this.collectionHealthy !== false) {
        this.logger.warn('Reservation queue metric collection failed');
      }
      this.collectionHealthy = false;
    }
  }

  private async pendingState(): Promise<{
    processing: number;
    retry: number;
    complete: boolean;
  }> {
    let groups: StreamGroupRow[];
    try {
      groups = (await this.redis.xinfo(
        'GROUPS',
        RESERVATION_STREAM,
      )) as StreamGroupRow[];
    } catch (error) {
      if (String(error).toLowerCase().includes('no such key')) {
        return { processing: 0, retry: 0, complete: true };
      }
      throw error;
    }

    const group = groups
      .map((row) => this.pairsToObject(row))
      .find((candidate) => candidate.name === RESERVATION_CONSUMER_GROUP);
    const processing = Number(group?.pending || 0);
    if (processing <= 0) {
      return { processing: 0, retry: 0, complete: true };
    }

    const scanLimit = this.retryScanLimit();
    const rows = (await this.redis.xpending(
      RESERVATION_STREAM,
      RESERVATION_CONSUMER_GROUP,
      '-',
      '+',
      Math.min(processing, scanLimit),
    )) as unknown as PendingRow[];
    return {
      processing,
      retry: rows.filter((entry) => Number(entry[3]) > 1).length,
      complete: processing <= scanLimit && rows.length >= processing,
    };
  }

  private pairsToObject(
    values: StreamGroupRow,
  ): Record<string, string | number> {
    return Object.fromEntries(
      Array.from({ length: values.length / 2 }, (_, index) => [
        String(values[index * 2]),
        values[index * 2 + 1],
      ]),
    );
  }

  private refreshIntervalMs(): number {
    const configured = Number(
      process.env.RESERVATION_METRICS_REFRESH_MS || 5000,
    );
    return Number.isInteger(configured) &&
      configured >= 1000 &&
      configured <= 60000
      ? configured
      : 5000;
  }

  private retryScanLimit(): number {
    const configured = Number(
      process.env.RESERVATION_METRICS_PEL_SCAN_LIMIT || 10000,
    );
    return Number.isInteger(configured) &&
      configured >= 100 &&
      configured <= 100000
      ? configured
      : 10000;
  }
}
