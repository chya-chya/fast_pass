import { HttpStatus } from '@nestjs/common';
import { ReservationService } from './reservation.service';

describe('ReservationService result contract', () => {
  const counter = {
    inc: jest.fn(),
    labels: jest.fn().mockReturnThis(),
  };

  function createService(pipelineResult: unknown) {
    const pipeline = {
      eval: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue(pipelineResult),
    };
    const redis = {
      pipeline: jest.fn(() => pipeline),
      get: jest.fn().mockResolvedValue('HELD'),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const prisma = {
      seat: { findUnique: jest.fn() },
    };
    const tracker = {
      normalizeTracking: jest.fn().mockReturnValue({}),
      recordAttempts: jest.fn().mockResolvedValue(undefined),
      enqueueMany: jest.fn().mockResolvedValue([[null, 1]]),
      enqueue: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReservationService(
      prisma as never,
      redis as never,
      counter as never,
      counter as never,
      counter as never,
      counter as never,
      tracker as never,
    );
    return { service, redis, prisma, tracker };
  }

  async function flush(service: ReservationService) {
    await (service as unknown as { flushQueue(): Promise<void> }).flushQueue();
  }

  it('uses 409 only for an explicit occupied-seat result', async () => {
    const { service } = createService([[null, 'FAIL']]);
    const pending = service.reserveSeat('user-1', { seatId: 'seat-1' });
    await flush(service);
    await expect(pending).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      errorCode: 'SEAT_ALREADY_RESERVED',
    });
  });

  it('maps Redis/Lua failure to store unavailable instead of conflict', async () => {
    const { service } = createService([
      [new Error('redis://internal-detail'), null],
    ]);
    const pending = service.reserveSeat('user-1', { seatId: 'seat-1' });
    await flush(service);
    await expect(pending).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: 'RESERVATION_STORE_UNAVAILABLE',
    });
  });

  it('maps enqueue failure to queue unavailable instead of conflict', async () => {
    const { service, tracker } = createService([[null, 'OK']]);
    tracker.enqueueMany.mockResolvedValueOnce([
      [new Error('queue internal detail'), null],
    ]);
    const pending = service.reserveSeat('user-1', { seatId: 'seat-1' });
    await flush(service);
    await expect(pending).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: 'RESERVATION_QUEUE_UNAVAILABLE',
    });
  });

  it('classifies a cold-cache follower only after the leader holds the seat', async () => {
    const { service } = createService([[null, 'WAIT']]);
    const pending = service.reserveSeat('user-1', { seatId: 'seat-1' });
    await flush(service);
    await expect(pending).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      errorCode: 'SEAT_ALREADY_RESERVED',
    });
  });

  it('does not hide a cold-cache Redis read failure as a conflict', async () => {
    const { service, redis } = createService([[null, 'WAIT']]);
    redis.get.mockRejectedValueOnce(new Error('redis unavailable'));
    const pending = service.reserveSeat('user-1', { seatId: 'seat-1' });
    await flush(service);
    await expect(pending).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: 'RESERVATION_STORE_UNAVAILABLE',
    });
  });

  it('distinguishes missing seats from database failures on the slow path', async () => {
    const missing = createService([[null, 'MISS']]);
    (missing.service as any).redlock = {
      acquire: jest
        .fn()
        .mockResolvedValue({ release: jest.fn().mockResolvedValue(undefined) }),
    };
    missing.prisma.seat.findUnique.mockResolvedValueOnce(null);
    const missingPending = missing.service.reserveSeat('user-1', {
      seatId: 'seat-1',
    });
    await flush(missing.service);
    await expect(missingPending).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      errorCode: 'SEAT_NOT_FOUND',
    });

    const failed = createService([[null, 'MISS']]);
    (failed.service as any).redlock = {
      acquire: jest
        .fn()
        .mockResolvedValue({ release: jest.fn().mockResolvedValue(undefined) }),
    };
    failed.prisma.seat.findUnique.mockRejectedValueOnce(
      new Error('postgresql://internal-detail'),
    );
    const failedPending = failed.service.reserveSeat('user-1', {
      seatId: 'seat-1',
    });
    await flush(failed.service);
    await expect(failedPending).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: 'RESERVATION_DATABASE_UNAVAILABLE',
    });
  });

  it('maps lock acquisition failure to lock unavailable instead of conflict', async () => {
    const { service } = createService([[null, 'MISS']]);
    (service as any).redlock = {
      acquire: jest.fn().mockRejectedValue(new Error('lock backend detail')),
    };
    const pending = service.reserveSeat('user-1', { seatId: 'seat-1' });
    await flush(service);
    await expect(pending).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: 'RESERVATION_LOCK_UNAVAILABLE',
    });
  });
});
