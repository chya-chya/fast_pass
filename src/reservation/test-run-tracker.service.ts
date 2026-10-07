import {
  BadRequestException,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
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

export type ReservationTerminalDecision =
  | { status: 'SUCCESS' }
  | { status: 'FAILURE'; failureCode: string };

export class ReservationClaimOwnershipError extends Error {
  constructor() {
    super('reservation claim ownership could not be verified');
    this.name = ReservationClaimOwnershipError.name;
  }
}

export const RESERVATION_STREAM = '{queue:reservations}:stream:v1';
export const RESERVATION_DLQ_STREAM = '{queue:reservations}:dlq:v1';
export const RESERVATION_CONSUMER_GROUP = 'reservation-workers-v1';
export const RESERVATION_TERMINAL_PREFIX = '{queue:reservations}:terminal:';
export const LEGACY_RESERVATION_LISTS = [
  'queue:reservations',
  '{queue:reservations}:processing',
  '{queue:reservations}:retry',
  '{queue:reservations}:dlq',
] as const;

const SAFE_TRACKING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/;
const TRACKING_TTL_SECONDS = 24 * 60 * 60;
const MIN_RECLAIM_IDLE_MS = 100;
const TERMINAL_SEPARATOR = '\u001f';
const CLAIM_OWNERSHIP_LOST = '__CLAIM_OWNERSHIP_LOST__';

type StreamEntry = [string, string[]];

@Injectable()
export class TestRunTrackerService implements OnModuleInit {
  private queueReady?: Promise<void>;
  private groupReady?: Promise<void>;
  private reclaimCursor = '0-0';
  private readonly consumerName = [
    hostname(),
    process.env.NODE_APP_INSTANCE || '0',
    process.pid,
    Math.random().toString(36).slice(2, 10),
  ].join('-');

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async onModuleInit(): Promise<void> {
    await this.ensureQueueReady();
  }

  private supportsXAutoClaim(commandInfo: unknown): boolean {
    if (!Array.isArray(commandInfo) || !Array.isArray(commandInfo[0])) {
      return false;
    }
    return String(commandInfo[0][0]).toLowerCase() === 'xautoclaim';
  }

  private async checkQueueReadiness(): Promise<void> {
    const commandInfo = await this.redis.command('INFO', 'XAUTOCLAIM');
    if (!this.supportsXAutoClaim(commandInfo)) {
      throw new Error('Redis 6.2+ with XAUTOCLAIM support is required');
    }

    const legacyBacklog = await Promise.all(
      LEGACY_RESERVATION_LISTS.map(async (key) => ({
        key,
        length: Number(await this.redis.llen(key)),
      })),
    );
    const nonEmptyLists = legacyBacklog.filter(({ length }) => length > 0);
    if (nonEmptyLists.length > 0) {
      const details = nonEmptyLists
        .map(({ key, length }) => `${key}=${length}`)
        .join(', ');
      throw new Error(
        `legacy reservation queues must be drained before startup: ${details}`,
      );
    }
  }

  private async ensureQueueReady(): Promise<void> {
    if (!this.queueReady) {
      this.queueReady = this.checkQueueReadiness();
    }
    const readiness = this.queueReady;
    try {
      await readiness;
    } catch (error) {
      if (this.queueReady === readiness) {
        this.queueReady = undefined;
      }
      throw error;
    }
  }

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

  normalizeQueueTracking(runId?: string, requestId?: string) {
    if (!runId && !requestId) return {};
    if (
      !runId ||
      !requestId ||
      !SAFE_TRACKING_ID.test(runId) ||
      !SAFE_TRACKING_ID.test(requestId)
    ) {
      throw new BadRequestException('queue tracking metadata rejected');
    }
    this.base(runId);
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
    return Number.isFinite(configured) && configured >= MIN_RECLAIM_IDLE_MS
      ? configured
      : 30000;
  }

  private terminalKey(message: ClaimedReservationMessage): string {
    return `${RESERVATION_TERMINAL_PREFIX}${
      message.reservationId || 'unknown'
    }:${message.streamId}`;
  }

  private terminalValue(
    status: 'SUCCESS' | 'FAILURE',
    failureCode = '',
  ): string {
    return `${status}${TERMINAL_SEPARATOR}${failureCode}`;
  }

  private parseTerminalValue(value: string): ReservationTerminalDecision {
    const separator = value.indexOf(TERMINAL_SEPARATOR);
    const status = separator === -1 ? value : value.slice(0, separator);
    const failureCode = separator === -1 ? '' : value.slice(separator + 1);
    if (status === 'SUCCESS') return { status };
    if (status === 'FAILURE') return { status, failureCode };
    throw new Error('invalid reservation terminal decision');
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
    await this.ensureQueueReady();
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
    await this.ensureQueueReady();
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

  async terminalDecision(
    message: ClaimedReservationMessage,
  ): Promise<ReservationTerminalDecision | null> {
    const value = await this.redis.get(this.terminalKey(message));
    return value ? this.parseTerminalValue(value) : null;
  }

  async assertClaimOwnership(
    message: ClaimedReservationMessage,
  ): Promise<void> {
    let refreshed: unknown;
    try {
      refreshed = await this.redis.eval(
        `
          local pending = redis.call('xpending', KEYS[1], ARGV[1], ARGV[3], ARGV[3], 1)
          if #pending == 0 or pending[1][2] ~= ARGV[2] then return 0 end
          local claimed = redis.call('xclaim', KEYS[1], ARGV[1], ARGV[2], 0, ARGV[3], 'JUSTID')
          return #claimed
        `,
        1,
        RESERVATION_STREAM,
        RESERVATION_CONSUMER_GROUP,
        this.consumerName,
        message.streamId,
      );
    } catch {
      throw new ReservationClaimOwnershipError();
    }
    if (Number(refreshed) !== 1) {
      throw new ReservationClaimOwnershipError();
    }
  }

  startClaimHeartbeat(message: ClaimedReservationMessage): () => Promise<void> {
    const heartbeatMs = Math.max(25, Math.floor(this.reclaimIdleMs() / 3));
    let stopped = false;
    let inFlight: Promise<void> | undefined;
    const refresh = () => {
      if (stopped || inFlight) return;
      inFlight = this.assertClaimOwnership(message)
        .catch(() => undefined)
        .finally(() => {
          inFlight = undefined;
        });
    };
    const timer = setInterval(refresh, heartbeatMs);
    return async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
      await this.assertClaimOwnership(message);
    };
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
    const terminalKey = this.terminalKey(message);
    const terminalValue = this.terminalValue(status, failureCode);
    const terminalStatus = await this.redis.eval(
      `
        local pending = redis.call('xpending', KEYS[1], ARGV[8], ARGV[1], ARGV[1], 1)
        if #pending == 0 or pending[1][2] ~= ARGV[9] then
          return '${CLAIM_OWNERSHIP_LOST}'
        end
        local first = redis.call('set', KEYS[2], ARGV[2], 'NX')
        if first and ARGV[7] == 'FAILURE' then
          redis.call('xadd', KEYS[3], '*',
            'sourceStreamId', ARGV[1],
            'reservationId', ARGV[3],
            'deliveryCount', ARGV[4],
            'failureCode', ARGV[5],
            'payload', ARGV[6])
        end
        if first then return ARGV[2] end
        return redis.call('get', KEYS[2])
      `,
      3,
      RESERVATION_STREAM,
      terminalKey,
      RESERVATION_DLQ_STREAM,
      message.streamId,
      terminalValue,
      message.reservationId || '',
      message.deliveryCount,
      failureCode,
      message.payload,
      status,
      RESERVATION_CONSUMER_GROUP,
      this.consumerName,
    );
    if (terminalStatus === CLAIM_OWNERSHIP_LOST) {
      throw new ReservationClaimOwnershipError();
    }
    if (terminalStatus !== terminalValue) {
      throw new Error('reservation terminal status conflict');
    }
  }

  private async acknowledge(message: ClaimedReservationMessage): Promise<void> {
    const acknowledged = await this.redis.eval(
      `
        local pending = redis.call('xpending', KEYS[1], ARGV[1], ARGV[2], ARGV[2], 1)
        if #pending == 0 or pending[1][2] ~= ARGV[3] then
          return '${CLAIM_OWNERSHIP_LOST}'
        end
        redis.call('xack', KEYS[1], ARGV[1], ARGV[2])
        redis.call('xdel', KEYS[1], ARGV[2])
        redis.call('del', KEYS[2])
        return 1
      `,
      2,
      RESERVATION_STREAM,
      this.terminalKey(message),
      RESERVATION_CONSUMER_GROUP,
      message.streamId,
      this.consumerName,
    );
    if (acknowledged === CLAIM_OWNERSHIP_LOST) {
      throw new ReservationClaimOwnershipError();
    }
    if (Number(acknowledged) !== 1) {
      throw new Error('reservation acknowledgement failed');
    }
  }

  async resumeFinalization(
    message: ClaimedReservationMessage,
    data: TrackedReservationData | undefined,
    decision: ReservationTerminalDecision,
  ): Promise<void> {
    if (decision.status === 'SUCCESS') {
      await this.markSuccess(message, data);
      return;
    }
    await this.markFailure(message, data, decision.failureCode);
  }

  async markSuccess(
    message: ClaimedReservationMessage,
    data: TrackedReservationData | undefined,
  ): Promise<void> {
    await this.beginFinalization(message, 'SUCCESS');
    if (data?.runId && data.requestId) {
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
