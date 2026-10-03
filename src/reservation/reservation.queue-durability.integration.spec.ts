import * as crypto from 'node:crypto';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { ReservationService } from './reservation.service';
import {
  RESERVATION_DLQ,
  RESERVATION_PROCESSING_QUEUE,
  RESERVATION_QUEUE,
  RESERVATION_RETRY_QUEUE,
  TestRunTrackerService,
  TrackedReservationData,
} from './test-run-tracker.service';

const integrationDescribe =
  process.env.RUN_QUEUE_DURABILITY_INTEGRATION === 'true'
    ? describe
    : describe.skip;

type DeferredTransaction = {
  reject: (reason: Error) => void;
  promise: Promise<never>;
};

integrationDescribe('Reservation queue durability integration', () => {
  let auditPool: Pool;
  let redis: Redis;
  let tracker: TestRunTrackerService;
  const runBases: string[] = [];
  const counter = {
    inc: jest.fn(),
    labels: jest.fn().mockReturnThis(),
  };

  beforeAll(async () => {
    if (
      process.env.TEST_ENVIRONMENT !== 'local-disposable' ||
      process.env.ALLOW_TEST_DATA_MUTATION !== 'true'
    ) {
      throw new Error(
        'queue durability integration requires a disposable environment',
      );
    }
    auditPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: false,
    });
    await auditPool.query('SELECT 1');
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      maxRetriesPerRequest: 1,
    });
    tracker = new TestRunTrackerService(redis);
  });

  beforeEach(async () => {
    counter.inc.mockClear();
    counter.labels.mockClear();
    await redis.del(
      RESERVATION_QUEUE,
      RESERVATION_PROCESSING_QUEUE,
      RESERVATION_RETRY_QUEUE,
      RESERVATION_DLQ,
    );
  });

  afterEach(async () => {
    const runKeys = runBases.flatMap((base) => [
      `${base}accepted`,
      `${base}processing`,
      `${base}processed`,
      `${base}failed`,
      `${base}counters`,
      `${base}state`,
      `${base}requests`,
    ]);
    if (runKeys.length > 0) await redis.del(...runKeys);
    runBases.length = 0;
    await redis.del(
      RESERVATION_QUEUE,
      RESERVATION_PROCESSING_QUEUE,
      RESERVATION_RETRY_QUEUE,
      RESERVATION_DLQ,
    );
  });

  afterAll(async () => {
    if (redis) await redis.quit();
    if (auditPool) await auditPool.end();
  });

  function makeItem(label: string): TrackedReservationData {
    const runId = `queue-durability-${label}-${crypto.randomUUID()}`;
    const base = `${process.env.REDIS_KEY_PREFIX}run:${runId}:`;
    runBases.push(base);
    return {
      id: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      seatId: crypto.randomUUID(),
      reservedAt: new Date().toISOString(),
      requestId: `request-${crypto.randomUUID()}`,
      runId,
    };
  }

  function baseFor(item: TrackedReservationData): string {
    return `${process.env.REDIS_KEY_PREFIX}run:${item.runId}:`;
  }

  function createService(transaction: jest.Mock) {
    const injectedPrisma = { $transaction: transaction };
    return new ReservationService(
      injectedPrisma as never,
      redis,
      counter as never,
      counter as never,
      counter as never,
      counter as never,
      tracker,
    );
  }

  async function queueState() {
    const [pending, processing, retry, dlq] = await Promise.all([
      redis.llen(RESERVATION_QUEUE),
      redis.llen(RESERVATION_PROCESSING_QUEUE),
      redis.llen(RESERVATION_RETRY_QUEUE),
      redis.llen(RESERVATION_DLQ),
    ]);
    return { pending, processing, retry, dlq };
  }

  async function persistedCount(reservationId: string): Promise<number> {
    const result = await auditPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM "Reservation" WHERE "id" = $1',
      [reservationId],
    );
    return Number(result.rows[0].count);
  }

  async function waitForProcessing() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await redis.llen(RESERVATION_PROCESSING_QUEUE)) === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('reservation did not enter the processing queue');
  }

  it('moves a deterministically failed DB transaction to DLQ without persistence', async () => {
    const item = makeItem('db-failure');
    const base = baseFor(item);
    const service = createService(
      jest.fn().mockRejectedValue(new Error('injected DB transaction failure')),
    );

    await tracker.enqueue(item);
    await expect(queueState()).resolves.toEqual({
      pending: 1,
      processing: 0,
      retry: 0,
      dlq: 0,
    });

    await expect(service.processNextReservation()).resolves.toBe(false);

    await expect(queueState()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      dlq: 1,
    });
    const [accepted, processed, failed, counters, dlqPayload, persisted] =
      await Promise.all([
        redis.hgetall(`${base}accepted`),
        redis.smembers(`${base}processed`),
        redis.hgetall(`${base}failed`),
        redis.hgetall(`${base}counters`),
        redis.lindex(RESERVATION_DLQ, 0),
        persistedCount(item.id),
      ]);

    expect(accepted).toEqual({ [item.id]: item.requestId });
    expect(processed).toEqual([]);
    expect(failed).toEqual({ [item.id]: 'PROCESSING_ERROR' });
    expect(JSON.parse(dlqPayload!)).toEqual(item);
    expect(persisted).toBe(0);
    expect(counters).toMatchObject({
      enqueue: '1',
      processing_started: '1',
      processed_failure: '1',
      dlq: '1',
      worker_in_flight: '0',
    });
    expect(counters.processed_success).toBeUndefined();
    expect(counters.retry).toBeUndefined();
  });

  it('exposes pending=0 while DB work is in flight but cannot reclaim it after a worker loss', async () => {
    const item = makeItem('worker-loss');
    const base = baseFor(item);
    let deferred: DeferredTransaction;
    deferred = {} as DeferredTransaction;
    deferred.promise = new Promise<never>((_resolve, reject) => {
      deferred.reject = reject;
    });
    const service = createService(jest.fn().mockReturnValue(deferred.promise));

    await tracker.enqueue(item);
    const processingResult = service.processNextReservation();
    await waitForProcessing();

    await expect(queueState()).resolves.toEqual({
      pending: 0,
      processing: 1,
      retry: 0,
      dlq: 0,
    });
    await expect(redis.hgetall(`${base}processing`)).resolves.toEqual({
      [item.id]: JSON.stringify({
        requestId: item.requestId,
        seatId: item.seatId,
      }),
    });
    await expect(redis.hgetall(`${base}counters`)).resolves.toMatchObject({
      enqueue: '1',
      processing_started: '1',
      worker_in_flight: '1',
    });
    await expect(tracker.claimNext()).resolves.toBeNull();
    await expect(persistedCount(item.id)).resolves.toBe(0);

    // Release the intentionally blocked promise so Jest can shut down cleanly.
    // A real process exit would leave this payload in processing indefinitely.
    deferred.reject(new Error('release injected in-flight transaction'));
    await expect(processingResult).resolves.toBe(false);
    await expect(queueState()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      dlq: 1,
    });
  });
});
