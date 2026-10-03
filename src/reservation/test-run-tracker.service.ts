import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';

export type TrackedReservationData = {
  userId: string;
  seatId: string;
  id: string;
  reservedAt: string;
  requestId?: string;
  runId?: string;
};

export const RESERVATION_QUEUE = 'queue:reservations';
export const RESERVATION_PROCESSING_QUEUE = 'queue:reservations:processing';
export const RESERVATION_RETRY_QUEUE = 'queue:reservations:retry';
export const RESERVATION_DLQ = 'queue:reservations:dlq';

const SAFE_TRACKING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/;
const TRACKING_TTL_SECONDS = 24 * 60 * 60;

@Injectable()
export class TestRunTrackerService {
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
            redis.call('rpush', KEYS[1], ARGV[1])
            redis.call('hset', KEYS[2], ARGV[2], ARGV[3])
            redis.call('hincrby', KEYS[3], 'enqueue', 1)
            local depth = redis.call('llen', KEYS[1])
            local maximum = tonumber(redis.call('hget', KEYS[3], 'max_queue_depth') or '0')
            if depth > maximum then redis.call('hset', KEYS[3], 'max_queue_depth', depth) end
            redis.call('expire', KEYS[2], ARGV[4])
            redis.call('expire', KEYS[3], ARGV[4])
            return depth
          `,
          3,
          RESERVATION_QUEUE,
          `${base}accepted`,
          `${base}counters`,
          payload,
          item.id,
          item.requestId,
          TRACKING_TTL_SECONDS,
        );
      } else {
        pipeline.rpush(RESERVATION_QUEUE, payload);
      }
    }
    return pipeline.exec();
  }

  async enqueue(item: TrackedReservationData): Promise<void> {
    const results = await this.enqueueMany([item]);
    const error = results?.[0]?.[0];
    if (error) throw error;
  }

  claimNext(): Promise<string | null> {
    return this.redis.lmove(
      RESERVATION_QUEUE,
      RESERVATION_PROCESSING_QUEUE,
      'LEFT',
      'RIGHT',
    );
  }

  async markProcessingStarted(data: TrackedReservationData): Promise<void> {
    if (!data.runId || !data.requestId) return;
    const base = this.base(data.runId);
    const transaction = this.redis.multi();
    transaction.hset(
      `${base}processing`,
      data.id,
      JSON.stringify({ requestId: data.requestId, seatId: data.seatId }),
    );
    transaction.hincrby(`${base}counters`, 'processing_started', 1);
    transaction.hincrby(`${base}counters`, 'worker_in_flight', 1);
    transaction.expire(`${base}processing`, TRACKING_TTL_SECONDS);
    await transaction.exec();
  }

  async markSuccess(
    rawData: string,
    data: TrackedReservationData,
  ): Promise<void> {
    const transaction = this.redis.multi();
    transaction.lrem(RESERVATION_PROCESSING_QUEUE, 1, rawData);
    if (data.runId && data.requestId) {
      const base = this.base(data.runId);
      transaction.sadd(`${base}processed`, data.id);
      transaction.hdel(`${base}processing`, data.id);
      transaction.hincrby(`${base}counters`, 'processed_success', 1);
      transaction.hincrby(`${base}counters`, 'worker_in_flight', -1);
      transaction.expire(`${base}processed`, TRACKING_TTL_SECONDS);
    }
    await transaction.exec();
  }

  async markFailure(
    rawData: string,
    data: TrackedReservationData | undefined,
    failureCode: string,
  ): Promise<void> {
    const transaction = this.redis.multi();
    transaction.lrem(RESERVATION_PROCESSING_QUEUE, 1, rawData);
    transaction.rpush(RESERVATION_DLQ, rawData);
    if (data?.runId && data.requestId) {
      const base = this.base(data.runId);
      transaction.hset(`${base}failed`, data.id, failureCode);
      transaction.hdel(`${base}processing`, data.id);
      transaction.hincrby(`${base}counters`, 'processed_failure', 1);
      transaction.hincrby(`${base}counters`, 'dlq', 1);
      transaction.hincrby(`${base}counters`, 'worker_in_flight', -1);
      transaction.expire(`${base}failed`, TRACKING_TTL_SECONDS);
    }
    await transaction.exec();
  }
}
