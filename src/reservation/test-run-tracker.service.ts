import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { hostname } from 'node:os';
import Redis from 'ioredis';

export type TrackedReservationData = {
  userId: string;
  seatId: string;
  id: string;
  reservedAt: string;
  requestId?: string;
  runId?: string;
};

export type ClaimedReservationMessage = {
  streamId: string;
  reservationId?: string;
  payload: string;
  deliveryCount: number;
  reclaimed: boolean;
};

export const RESERVATION_STREAM = '{queue:reservations}:stream:v1';
export const RESERVATION_DLQ_STREAM = '{queue:reservations}:dlq:v1';
export const RESERVATION_CONSUMER_GROUP = 'reservation-workers-v1';
export const RESERVATION_TERMINAL_PREFIX = '{queue:reservations}:terminal:';

const SAFE_TRACKING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/;
const TRACKING_TTL_SECONDS = 24 * 60 * 60;
const TERMINAL_TTL_SECONDS = 24 * 60 * 60;

type StreamEntry = [string, string[]];

@Injectable()
export class TestRunTrackerService {
  private groupReady?: Promise<void>;
  private reclaimCursor = '0-0';
  private readonly consumerName = [
    hostname(),
    process.env.NODE_APP_INSTANCE || '0',
    process.pid,
    Math.random().toString(36).slice(2, 10),
  ].join('-');

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  normalizeTracking(runId?: string, requestId?: string) {
    if (!runId && !requestId) return {};
    if (
      process.env.NODE_ENV === 'production' ||
      process.env.ENABLE_TEST_PREFLIGHT !== 'true' ||
      process.env.TEST_ENVIRONMENT !== 'local-disposable' ||
      process.env.ALLOW_TEST_DATA_MUTATION !== 'true' ||
      !runId ||
      !requestId ||
      !SAFE_TRACKING_ID.test(runId) ||
      !SAFE_TRACKING_ID.test(requestId)
    ) {
      throw new BadRequestException('test tracking headers rejected');
    }
    return { runId, requestId };
  }

  private base(runId: string): string {
    const prefix = process.env.REDIS_KEY_PREFIX || '';
    const testEnvId = process.env.TEST_ENV_ID || '';
    if (prefix !== `k6:${testEnvId}:`) {
      throw new BadRequestException('test tracking environment rejected');
    }
    return `${prefix}run:${runId}:`;
  }

  private reclaimIdleMs(): number {
    const configured = Number(process.env.RESERVATION_RECLAIM_IDLE_MS || 30000);
    return Number.isFinite(configured) && configured >= 0 ? configured : 30000;
  }

  private async ensureConsumerGroup(): Promise<void> {
    if (!this.groupReady) {
      this.groupReady = this.redis
        .xgroup(
          'CREATE',
          RESERVATION_STREAM,
          RESERVATION_CONSUMER_GROUP,
          '0',
          'MKSTREAM',
        )
        .then(() => {
          this.reclaimCursor = '0-0';
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message.includes('BUSYGROUP')) {
            return;
          }
          this.groupReady = undefined;
          throw error;
        });
    }
    await this.groupReady;
  }

  private parseEntry(
    entry: StreamEntry,
    deliveryCount: number,
    reclaimed: boolean,
  ): ClaimedReservationMessage {
    const [streamId, fields] = entry;
    const values: Record<string, string> = {};
    for (let index = 0; index < fields.length; index += 2) {
      values[fields[index]] = fields[index + 1];
    }
    return {
      streamId,
      reservationId: values.reservationId,
      payload: values.payload || '',
      deliveryCount,
      reclaimed,
    };
  }

  private async deliveryCount(streamId: string): Promise<number> {
    const rows = (await this.redis.xpending(
      RESERVATION_STREAM,
      RESERVATION_CONSUMER_GROUP,
      streamId,
      streamId,
      1,
    )) as unknown as Array<[string, string, number, number]>;
    return Number(rows[0]?.[3] || 1);
  }

  async recordAttempts(items: TrackedReservationData[]): Promise<void> {
    const tracked = items.filter((item) => item.runId && item.requestId);
    if (tracked.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const item of tracked) {
      const base = this.base(item.runId!);
      pipeline.eval(
        `
          if redis.call('hexists', KEYS[1], ARGV[1]) == 1 then return 0 end
          redis.call('hset', KEYS[1], ARGV[1], ARGV[2])
          redis.call('hincrby', KEYS[2], 'attempts', 1)
          redis.call('expire', KEYS[1], ARGV[3])
          redis.call('expire', KEYS[2], ARGV[3])
          return 1
        `,
        2,
        `${base}requests`,
        `${base}counters`,
        item.requestId!,
        JSON.stringify({ seatId: item.seatId, userId: item.userId }),
        TRACKING_TTL_SECONDS,
      );
    }
    const results = await pipeline.exec();
    if (
      !results ||
      results.length !== tracked.length ||
      results.some(([error, value]) => error || Number(value) !== 1)
    ) {
      throw new Error('test request manifest rejected');
    }
  }

  async enqueueMany(items: TrackedReservationData[]) {
    const pipeline = this.redis.pipeline();
    for (const item of items) {
      const payload = JSON.stringify(item);
      if (item.runId && item.requestId) {
        const base = this.base(item.runId);
        pipeline.eval(
          `
            local stream_id = redis.call('xadd', KEYS[1], '*',
              'reservationId', ARGV[2], 'payload', ARGV[1])
            redis.call('hset', KEYS[2], ARGV[2], ARGV[3])
            redis.call('hincrby', KEYS[3], 'enqueue', 1)
            local depth = redis.call('xlen', KEYS[1])
            local maximum = tonumber(redis.call('hget', KEYS[3], 'max_queue_depth') or '0')
            if depth > maximum then redis.call('hset', KEYS[3], 'max_queue_depth', depth) end
            redis.call('expire', KEYS[2], ARGV[4])
            redis.call('expire', KEYS[3], ARGV[4])
            return stream_id
          `,
          3,
          RESERVATION_STREAM,
          `${base}accepted`,
          `${base}counters`,
          payload,
          item.id,
          item.requestId,
          TRACKING_TTL_SECONDS,
        );
      } else {
        pipeline.xadd(
          RESERVATION_STREAM,
          '*',
          'reservationId',
          item.id,
          'payload',
          payload,
        );
      }
    }
    return pipeline.exec();
  }

  async enqueue(item: TrackedReservationData): Promise<void> {
    const results = await this.enqueueMany([item]);
    const error = results?.[0]?.[0];
    if (error) throw error;
  }

  private async claim(): Promise<ClaimedReservationMessage | null> {
    const reclaimed = (await this.redis.xautoclaim(
      RESERVATION_STREAM,
      RESERVATION_CONSUMER_GROUP,
      this.consumerName,
      this.reclaimIdleMs(),
      this.reclaimCursor,
      'COUNT',
      1,
    )) as [string, StreamEntry[]];
    this.reclaimCursor = reclaimed[0] || '0-0';
    const reclaimedEntry = reclaimed[1]?.[0];
    if (reclaimedEntry) {
      return this.parseEntry(
        reclaimedEntry,
        await this.deliveryCount(reclaimedEntry[0]),
        true,
      );
    }

    const fresh = (await this.redis.xreadgroup(
      'GROUP',
      RESERVATION_CONSUMER_GROUP,
      this.consumerName,
      'COUNT',
      1,
      'STREAMS',
      RESERVATION_STREAM,
      '>',
    )) as [string, StreamEntry[]][] | null;
    const freshEntry = fresh?.[0]?.[1]?.[0];
    return freshEntry ? this.parseEntry(freshEntry, 1, false) : null;
  }

  async claimNext(): Promise<ClaimedReservationMessage | null> {
    await this.ensureConsumerGroup();
    try {
      return await this.claim();
    } catch (error) {
      if (error instanceof Error && error.message.includes('NOGROUP')) {
        this.groupReady = undefined;
        this.reclaimCursor = '0-0';
        await this.ensureConsumerGroup();
        return this.claim();
      }
      throw error;
    }
  }

  async markProcessingStarted(
    message: ClaimedReservationMessage,
    data: TrackedReservationData,
  ): Promise<void> {
    if (!data.runId || !data.requestId) return;
    const base = this.base(data.runId);
    await this.redis.eval(
      `
        local is_first = redis.call('hsetnx', KEYS[1], ARGV[1], ARGV[2])
        if is_first == 1 then
          redis.call('hincrby', KEYS[2], 'processing_started', 1)
          redis.call('hincrby', KEYS[2], 'worker_in_flight', 1)
        else
          redis.call('hset', KEYS[1], ARGV[1], ARGV[2])
        end
        redis.call('expire', KEYS[1], ARGV[3])
        redis.call('expire', KEYS[2], ARGV[3])
        return is_first
      `,
      2,
      `${base}processing`,
      `${base}counters`,
      data.id,
      JSON.stringify({
        requestId: data.requestId,
        seatId: data.seatId,
        streamId: message.streamId,
        deliveryCount: message.deliveryCount,
        reclaimed: message.reclaimed,
      }),
      TRACKING_TTL_SECONDS,
    );
  }

  async markRetry(
    message: ClaimedReservationMessage,
    data: TrackedReservationData | undefined,
    failureCode: string,
  ): Promise<void> {
    if (!data?.runId || !data.requestId) return;
    const base = this.base(data.runId);
    const transaction = this.redis.multi();
    transaction.hset(
      `${base}processing`,
      data.id,
      JSON.stringify({
        requestId: data.requestId,
        seatId: data.seatId,
        streamId: message.streamId,
        deliveryCount: message.deliveryCount,
        failureCode,
      }),
    );
    transaction.hincrby(`${base}counters`, 'retry', 1);
    transaction.expire(`${base}processing`, TRACKING_TTL_SECONDS);
    transaction.expire(`${base}counters`, TRACKING_TTL_SECONDS);
    await transaction.exec();
  }

  private async beginFinalization(
    message: ClaimedReservationMessage,
    status: 'SUCCESS' | 'FAILURE',
    failureCode = '',
  ): Promise<void> {
    const terminalKey = `${RESERVATION_TERMINAL_PREFIX}${
      message.reservationId || 'unknown'
    }:${message.streamId}`;
    const terminalStatus = await this.redis.eval(
      `
        local first = redis.call('set', KEYS[2], ARGV[2], 'NX', 'EX', ARGV[3])
        if first and ARGV[2] == 'FAILURE' then
          redis.call('xadd', KEYS[3], '*',
            'sourceStreamId', ARGV[1],
            'reservationId', ARGV[4],
            'deliveryCount', ARGV[5],
            'failureCode', ARGV[6],
            'payload', ARGV[7])
        end
        if first then return ARGV[2] end
        return redis.call('get', KEYS[2])
      `,
      3,
      RESERVATION_STREAM,
      terminalKey,
      RESERVATION_DLQ_STREAM,
      message.streamId,
      status,
      TERMINAL_TTL_SECONDS,
      message.reservationId || '',
      message.deliveryCount,
      failureCode,
      message.payload,
    );
    if (terminalStatus !== status) {
      throw new Error('reservation terminal status conflict');
    }
  }

  private async acknowledge(message: ClaimedReservationMessage): Promise<void> {
    await this.redis.eval(
      `
        redis.call('xack', KEYS[1], ARGV[1], ARGV[2])
        redis.call('xdel', KEYS[1], ARGV[2])
        return 1
      `,
      1,
      RESERVATION_STREAM,
      RESERVATION_CONSUMER_GROUP,
      message.streamId,
    );
  }

  async markSuccess(
    message: ClaimedReservationMessage,
    data: TrackedReservationData,
  ): Promise<void> {
    await this.beginFinalization(message, 'SUCCESS');
    if (data.runId && data.requestId) {
      const base = this.base(data.runId);
      await this.redis.eval(
        `
          if redis.call('hsetnx', KEYS[1], ARGV[1], 'SUCCESS') == 0 then return 0 end
          redis.call('sadd', KEYS[2], ARGV[1])
          redis.call('hdel', KEYS[3], ARGV[1])
          redis.call('hincrby', KEYS[4], 'processed_success', 1)
          redis.call('hincrby', KEYS[4], 'worker_in_flight', -1)
          redis.call('expire', KEYS[1], ARGV[2])
          redis.call('expire', KEYS[2], ARGV[2])
          redis.call('expire', KEYS[3], ARGV[2])
          redis.call('expire', KEYS[4], ARGV[2])
          return 1
        `,
        4,
        `${base}terminal`,
        `${base}processed`,
        `${base}processing`,
        `${base}counters`,
        data.id,
        TRACKING_TTL_SECONDS,
      );
    }
    await this.acknowledge(message);
  }

  async markFailure(
    message: ClaimedReservationMessage,
    data: TrackedReservationData | undefined,
    failureCode: string,
  ): Promise<void> {
    await this.beginFinalization(message, 'FAILURE', failureCode);
    if (data?.runId && data.requestId) {
      const base = this.base(data.runId);
      await this.redis.eval(
        `
          if redis.call('hsetnx', KEYS[1], ARGV[1], 'FAILURE') == 0 then return 0 end
          redis.call('hset', KEYS[2], ARGV[1], ARGV[2])
          redis.call('hdel', KEYS[3], ARGV[1])
          redis.call('hincrby', KEYS[4], 'processed_failure', 1)
          redis.call('hincrby', KEYS[4], 'dlq', 1)
          redis.call('hincrby', KEYS[4], 'worker_in_flight', -1)
          redis.call('expire', KEYS[1], ARGV[3])
          redis.call('expire', KEYS[2], ARGV[3])
          redis.call('expire', KEYS[3], ARGV[3])
          redis.call('expire', KEYS[4], ARGV[3])
          return 1
        `,
        4,
        `${base}terminal`,
        `${base}failed`,
        `${base}processing`,
        `${base}counters`,
        data.id,
        failureCode,
        TRACKING_TTL_SECONDS,
      );
    }
    await this.acknowledge(message);
  }
}
