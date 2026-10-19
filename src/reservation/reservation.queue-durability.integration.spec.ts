import * as crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationService } from './reservation.service';
import {
  ClaimedReservationMessage,
  ReservationClaimOwnershipError,
  RESERVATION_CONSUMER_GROUP,
  RESERVATION_DLQ_STREAM,
  RESERVATION_STREAM,
  RESERVATION_TERMINAL_PREFIX,
  TestRunTrackerService,
  TrackedReservationData,
} from './test-run-tracker.service';

const integrationDescribe =
  process.env.RUN_QUEUE_DURABILITY_INTEGRATION === 'true'
    ? describe
    : describe.skip;

integrationDescribe('Reservation queue durability integration', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let tracker: TestRunTrackerService;
  const runBases: string[] = [];
  const reservationIds: string[] = [];
  const userIds: string[] = [];
  const eventIds: string[] = [];
  const performanceIds: string[] = [];
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
    process.env.RESERVATION_RECLAIM_IDLE_MS = '100';
    process.env.RESERVATION_MAX_DELIVERIES = '3';
    prisma = new PrismaService();
    await prisma.$connect();
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
    await clearQueue();
    tracker = new TestRunTrackerService(redis);
  });

  afterEach(async () => {
    const runKeys = runBases.flatMap((base) => [
      `${base}accepted`,
      `${base}processing`,
      `${base}processed`,
      `${base}failed`,
      `${base}terminal`,
      `${base}counters`,
      `${base}state`,
      `${base}requests`,
    ]);
    const terminalKeys = await redis.keys(`${RESERVATION_TERMINAL_PREFIX}*`);
    if (runKeys.length + terminalKeys.length > 0) {
      await redis.del(...runKeys, ...terminalKeys);
    }
    await clearQueue();
    if (reservationIds.length > 0) {
      await prisma.reservation.deleteMany({
        where: { id: { in: reservationIds } },
      });
    }
    if (performanceIds.length > 0) {
      await prisma.seat.deleteMany({
        where: { performanceId: { in: performanceIds } },
      });
      await prisma.performance.deleteMany({
        where: { id: { in: performanceIds } },
      });
    }
    if (eventIds.length > 0) {
      await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }
    if (userIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    runBases.length = 0;
    reservationIds.length = 0;
    userIds.length = 0;
    eventIds.length = 0;
    performanceIds.length = 0;
  });

  afterAll(async () => {
    if (redis) await redis.quit();
    if (prisma) await prisma.$disconnect();
  });

  async function clearQueue() {
    if (redis) await redis.del(RESERVATION_STREAM, RESERVATION_DLQ_STREAM);
  }

  function makeItem(label: string): TrackedReservationData {
    const runId = `queue-durability-${label}-${crypto.randomUUID()}`;
    const base = `${process.env.REDIS_KEY_PREFIX}run:${runId}:`;
    const item = {
      id: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      seatId: crypto.randomUUID(),
      reservedAt: new Date().toISOString(),
      requestId: `request-${crypto.randomUUID()}`,
      runId,
    };
    runBases.push(base);
    reservationIds.push(item.id);
    return item;
  }

  function baseFor(item: TrackedReservationData): string {
    return `${process.env.REDIS_KEY_PREFIX}run:${item.runId}:`;
  }

  async function createFixture(item: TrackedReservationData) {
    const eventId = crypto.randomUUID();
    const performanceId = crypto.randomUUID();
    userIds.push(item.userId);
    eventIds.push(eventId);
    performanceIds.push(performanceId);
    await prisma.user.create({
      data: {
        id: item.userId,
        email: `${item.userId}@example.invalid`,
        password: 'queue-durability-fixture',
        name: 'queue durability',
      },
    });
    await prisma.event.create({
      data: { id: eventId, title: eventId, userId: item.userId },
    });
    await prisma.performance.create({
      data: {
        id: performanceId,
        eventId,
        startAt: new Date(Date.now() + 86_400_000),
        totalSeats: 1,
        availableSeats: 1,
      },
    });
    await prisma.seat.create({
      data: {
        id: item.seatId,
        performanceId,
        seatNumber: 'A1',
      },
    });
  }

  function createService(
    injectedPrisma: Pick<
      PrismaService,
      '$transaction' | 'reservation'
    > = prisma,
    injectedTracker = tracker,
  ) {
    return new ReservationService(
      injectedPrisma as PrismaService,
      redis,
      counter as never,
      counter as never,
      counter as never,
      counter as never,
      injectedTracker,
    );
  }

  async function waitForReclaim() {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  async function groupState() {
    let lag = await redis.xlen(RESERVATION_STREAM);
    let pending = 0;
    try {
      const groups = (await redis.xinfo('GROUPS', RESERVATION_STREAM)) as Array<
        Array<string | number>
      >;
      const group = groups
        .map((row) =>
          Object.fromEntries(
            Array.from({ length: row.length / 2 }, (_, index) => [
              String(row[index * 2]),
              row[index * 2 + 1],
            ]),
          ),
        )
        .find((row) => row.name === RESERVATION_CONSUMER_GROUP);
      if (group) {
        lag = Number(group.lag || 0);
        pending = Number(group.pending || 0);
      }
    } catch {
      // A deleted or not-yet-created stream has no group state.
    }
    const pendingRows = pending
      ? ((await redis.xpending(
          RESERVATION_STREAM,
          RESERVATION_CONSUMER_GROUP,
          '-',
          '+',
          100,
        )) as unknown as Array<[string, string, number, number]>)
      : [];
    return {
      pending: lag,
      processing: pending,
      retry: pendingRows.filter((row) => Number(row[3]) > 1).length,
      dlq: await redis.xlen(RESERVATION_DLQ_STREAM),
    };
  }

  async function dlqFields() {
    const entries = (await redis.xrange(
      RESERVATION_DLQ_STREAM,
      '-',
      '+',
    )) as Array<[string, string[]]>;
    return entries.map(([, fields]) =>
      Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, index) => [
          fields[index * 2],
          fields[index * 2 + 1],
        ]),
      ),
    );
  }

  it('retries transient DB failures with a limit and eventually succeeds', async () => {
    const item = makeItem('transient-db');
    await createFixture(item);
    let attempts = 0;
    const flakyPrisma = {
      reservation: prisma.reservation,
      $transaction: jest.fn(
        (callback: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          attempts += 1;
          if (attempts < 3) {
            return Promise.reject(new Error('injected transient DB failure'));
          }
          return prisma.$transaction(callback);
        },
      ),
    };
    const service = createService(flakyPrisma as never);

    await tracker.enqueue(item);
    await expect(service.processNextReservation()).resolves.toBe(false);
    await waitForReclaim();
    await expect(service.processNextReservation()).resolves.toBe(false);
    await waitForReclaim();
    await expect(service.processNextReservation()).resolves.toBe(true);

    await expect(groupState()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      dlq: 0,
    });
    await expect(
      prisma.reservation.count({ where: { id: item.id } }),
    ).resolves.toBe(1);
    await expect(
      redis.hgetall(`${baseFor(item)}counters`),
    ).resolves.toMatchObject({
      enqueue: '1',
      processing_started: '1',
      retry: '2',
      processed_success: '1',
      worker_in_flight: '0',
    });
  });

  it('recovers a stale claim after the original worker disappears', async () => {
    const item = makeItem('worker-loss');
    await createFixture(item);
    await tracker.enqueue(item);
    const abandoned = await tracker.claimNext();
    expect(abandoned).not.toBeNull();
    await tracker.markProcessingStarted(abandoned!, item);
    await expect(groupState()).resolves.toMatchObject({
      pending: 0,
      processing: 1,
    });

    await waitForReclaim();
    const replacementTracker = new TestRunTrackerService(redis);
    const replacement = createService(prisma, replacementTracker);
    await expect(replacement.processNextReservation()).resolves.toBe(true);

    await expect(groupState()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      dlq: 0,
    });
    await expect(
      prisma.reservation.count({ where: { id: item.id } }),
    ).resolves.toBe(1);
  });

  it('treats redelivery after DB commit and worker loss as idempotent success', async () => {
    const item = makeItem('commit-before-ack');
    await createFixture(item);
    await tracker.enqueue(item);
    const abandoned = await tracker.claimNext();
    expect(abandoned).not.toBeNull();
    await tracker.markProcessingStarted(abandoned!, item);
    await prisma.$transaction(async (tx) => {
      await tx.seat.update({
        where: { id: item.seatId },
        data: { status: 'HELD', version: { increment: 1 } },
      });
      await tx.reservation.create({
        data: {
          id: item.id,
          userId: item.userId,
          seatId: item.seatId,
          reservedAt: new Date(item.reservedAt),
        },
      });
    });

    await waitForReclaim();
    const replacement = createService(prisma, new TestRunTrackerService(redis));
    await expect(replacement.processNextReservation()).resolves.toBe(true);

    await expect(
      prisma.reservation.count({ where: { id: item.id } }),
    ).resolves.toBe(1);
    await expect(groupState()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      dlq: 0,
    });
  });

  it('moves a message to DLQ after the maximum transient deliveries', async () => {
    const item = makeItem('max-retry');
    const failingPrisma = {
      reservation: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest
        .fn()
        .mockRejectedValue(new Error('injected persistent DB failure')),
    };
    const service = createService(failingPrisma as never);
    await tracker.enqueue(item);

    await expect(service.processNextReservation()).resolves.toBe(false);
    await waitForReclaim();
    await expect(service.processNextReservation()).resolves.toBe(false);
    await waitForReclaim();
    await expect(service.processNextReservation()).resolves.toBe(false);

    await expect(groupState()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      dlq: 1,
    });
    await expect(dlqFields()).resolves.toEqual([
      expect.objectContaining({
        reservationId: item.id,
        deliveryCount: '3',
        failureCode: 'PROCESSING_ERROR',
      }),
    ]);
  });

  it('moves a poison payload directly to DLQ', async () => {
    const reservationId = crypto.randomUUID();
    reservationIds.push(reservationId);
    await redis.xadd(
      RESERVATION_STREAM,
      '*',
      'reservationId',
      reservationId,
      'payload',
      '{not-json',
    );

    await expect(createService().processNextReservation()).resolves.toBe(false);

    await expect(groupState()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      dlq: 1,
    });
    await expect(dlqFields()).resolves.toEqual([
      expect.objectContaining({
        reservationId,
        deliveryCount: '1',
        failureCode: 'POISON_MESSAGE',
      }),
    ]);
  });

  it('allows only one worker to reclaim the same stale message', async () => {
    const item = makeItem('reclaim-race');
    await tracker.enqueue(item);
    await expect(tracker.claimNext()).resolves.not.toBeNull();
    await waitForReclaim();

    const contenders = [
      new TestRunTrackerService(redis),
      new TestRunTrackerService(redis),
      new TestRunTrackerService(redis),
    ];
    const claims = await Promise.all(
      contenders.map((candidate) => candidate.claimNext()),
    );
    const winners = claims.filter(
      (claim): claim is ClaimedReservationMessage => claim !== null,
    );
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({
      reservationId: item.id,
      deliveryCount: 2,
      reclaimed: true,
    });
    await contenders[claims.indexOf(winners[0])].markFailure(
      winners[0],
      item,
      'TEST_CLEANUP',
    );
  });

  it('prevents a stale worker from finalizing after another worker reclaims', async () => {
    const item = makeItem('stale-finalizer');
    await tracker.enqueue(item);
    const staleClaim = await tracker.claimNext();
    expect(staleClaim).not.toBeNull();
    await waitForReclaim();

    const replacementTracker = new TestRunTrackerService(redis);
    const replacementClaim = await replacementTracker.claimNext();
    expect(replacementClaim).toMatchObject({
      reservationId: item.id,
      deliveryCount: 2,
      reclaimed: true,
    });

    await expect(
      tracker.markFailure(staleClaim!, undefined, 'STALE_WORKER'),
    ).rejects.toBeInstanceOf(ReservationClaimOwnershipError);
    await expect(dlqFields()).resolves.toEqual([]);
    await expect(groupState()).resolves.toMatchObject({
      processing: 1,
      dlq: 0,
    });

    await replacementTracker.markFailure(
      replacementClaim!,
      undefined,
      'TEST_CLEANUP',
    );
    await expect(groupState()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      dlq: 1,
    });
  });

  it('conserves accepted IDs across DB success and terminal failure', async () => {
    const success = makeItem('conservation-success');
    const failure = makeItem('conservation-failure');
    await createFixture(success);
    await tracker.enqueueMany([success, failure]);
    await expect(createService().processNextReservation()).resolves.toBe(true);

    const failingPrisma = {
      reservation: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockRejectedValue(new Error('forced failure')),
    };
    const failingService = createService(failingPrisma as never);
    await expect(failingService.processNextReservation()).resolves.toBe(false);
    await waitForReclaim();
    await expect(failingService.processNextReservation()).resolves.toBe(false);
    await waitForReclaim();
    await expect(failingService.processNextReservation()).resolves.toBe(false);

    const [successAccepted, successProcessed, failureAccepted, failed] =
      await Promise.all([
        redis.hkeys(`${baseFor(success)}accepted`),
        redis.smembers(`${baseFor(success)}processed`),
        redis.hkeys(`${baseFor(failure)}accepted`),
        redis.hkeys(`${baseFor(failure)}failed`),
      ]);
    const accepted = [...successAccepted, ...failureAccepted].sort();
    const terminal = [...successProcessed, ...failed].sort();
    expect(terminal).toEqual(accepted);
    await expect(
      prisma.reservation.count({ where: { id: { in: accepted } } }),
    ).resolves.toBe(1);
    await expect(groupState()).resolves.toEqual({
      pending: 0,
      processing: 0,
      retry: 0,
      dlq: 1,
    });
  });
});
