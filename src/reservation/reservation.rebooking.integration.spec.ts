import Redis from 'ioredis';
import * as crypto from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationService } from './reservation.service';
import {
  RESERVATION_DLQ,
  RESERVATION_PROCESSING_QUEUE,
  RESERVATION_QUEUE,
  RESERVATION_RETRY_QUEUE,
  TestRunTrackerService,
} from './test-run-tracker.service';

const integrationDescribe =
  process.env.RUN_REBOOKING_INTEGRATION === 'true' ? describe : describe.skip;

integrationDescribe('Reservation rebooking integration', () => {
  let prisma: PrismaService;
  let redis: Redis;
  let service: ReservationService;
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
        'rebooking integration requires a disposable environment',
      );
    }
    prisma = new PrismaService();
    await prisma.$connect();
    redis = new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      maxRetriesPerRequest: 1,
    });
    const tracker = new TestRunTrackerService(redis);
    service = new ReservationService(
      prisma,
      redis,
      counter as never,
      counter as never,
      counter as never,
      counter as never,
      tracker,
    );
    await redis.del(
      RESERVATION_QUEUE,
      RESERVATION_PROCESSING_QUEUE,
      RESERVATION_RETRY_QUEUE,
      RESERVATION_DLQ,
    );
  });

  afterAll(async () => {
    if (redis) await redis.quit();
    if (prisma) await prisma.$disconnect();
  });

  async function flushPendingBatch() {
    await (service as unknown as { flushQueue(): Promise<void> }).flushQueue();
  }

  async function createFixture(label: string) {
    const suffix = crypto.randomUUID();
    const user = await prisma.user.create({
      data: {
        email: `${label}-${suffix}@example.invalid`,
        password: `K6-${suffix}-fixture`,
        name: `${label} integration`,
      },
    });
    const event = await prisma.event.create({
      data: { title: `${label}-${suffix}`, userId: user.id },
    });
    const performance = await prisma.performance.create({
      data: {
        eventId: event.id,
        startAt: new Date(Date.now() + 86_400_000),
        totalSeats: 1,
        availableSeats: 1,
      },
    });
    const seat = await prisma.seat.create({
      data: { performanceId: performance.id, seatNumber: 'A1' },
    });
    await redis.set(`seat:${seat.id}:status`, 'AVAILABLE', 'EX', 600);
    return { user, seat };
  }

  it('preserves cancelled history and persists a second reservation for the same seat', async () => {
    const { user, seat } = await createFixture('rebooking');

    const firstPromise = service.reserveSeat(user.id, { seatId: seat.id });
    await flushPendingBatch();
    const first = await firstPromise;
    await expect(service.processNextReservation()).resolves.toBe(true);

    await service.cancelReservation(first.id, user.id);
    await expect(
      prisma.seat.findUniqueOrThrow({ where: { id: seat.id } }),
    ).resolves.toMatchObject({ status: 'AVAILABLE' });

    const secondPromise = service.reserveSeat(user.id, { seatId: seat.id });
    await flushPendingBatch();
    const second = await secondPromise;
    expect(second.id).not.toBe(first.id);
    await expect(service.processNextReservation()).resolves.toBe(true);

    const reservations = await prisma.reservation.findMany({
      where: { seatId: seat.id },
      orderBy: { reservedAt: 'asc' },
    });
    expect(reservations).toHaveLength(2);
    expect(reservations.map((reservation) => reservation.status)).toEqual([
      'CANCELLED',
      'PENDING',
    ]);
    expect(
      reservations.filter((reservation) =>
        ['PENDING', 'CONFIRMED'].includes(reservation.status),
      ),
    ).toHaveLength(1);

    await expect(
      prisma.reservation.create({
        data: {
          id: crypto.randomUUID(),
          userId: user.id,
          seatId: seat.id,
          status: 'PENDING',
        },
      }),
    ).rejects.toBeDefined();

    await service.cancelReservation(second.id, user.id);
    const thirdPromise = service.reserveSeat(user.id, { seatId: seat.id });
    await flushPendingBatch();
    await thirdPromise;
    await expect(service.processNextReservation()).resolves.toBe(true);
    const finalHistory = await prisma.reservation.findMany({
      where: { seatId: seat.id },
      orderBy: { reservedAt: 'asc' },
    });
    expect(
      finalHistory.filter((reservation) => reservation.status === 'CANCELLED'),
    ).toHaveLength(2);
    expect(
      finalHistory.filter((reservation) => reservation.status === 'PENDING'),
    ).toHaveLength(1);
  });

  it('releases an expired reservation and persists its replacement', async () => {
    const { user, seat } = await createFixture('expiration');
    const firstPromise = service.reserveSeat(user.id, { seatId: seat.id });
    await flushPendingBatch();
    const first = await firstPromise;
    await expect(service.processNextReservation()).resolves.toBe(true);
    await prisma.reservation.update({
      where: { id: first.id },
      data: { reservedAt: new Date(Date.now() - 20 * 60 * 1000) },
    });

    await expect(
      service.expireOverdueReservations(new Date(Date.now() - 10 * 60 * 1000)),
    ).resolves.toBe(1);
    await expect(
      prisma.seat.findUniqueOrThrow({ where: { id: seat.id } }),
    ).resolves.toMatchObject({ status: 'AVAILABLE' });

    const secondPromise = service.reserveSeat(user.id, { seatId: seat.id });
    await flushPendingBatch();
    await secondPromise;
    await expect(service.processNextReservation()).resolves.toBe(true);
    const history = await prisma.reservation.findMany({
      where: { seatId: seat.id },
    });
    expect(history).toHaveLength(2);
    expect(
      history.filter((reservation) => reservation.status === 'CANCELLED'),
    ).toHaveLength(1);
    expect(
      history.filter((reservation) => reservation.status === 'PENDING'),
    ).toHaveLength(1);
  });
});
