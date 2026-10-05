import { ConflictException, HttpStatus, Logger } from '@nestjs/common';
import { ReservationService } from './reservation.service';

describe('ReservationService result contract', () => {
  const counter = {
    inc: jest.fn(),
    labels: jest.fn().mockReturnThis(),
  };

  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  function allowLock(service: ReservationService) {
    Object.defineProperty(service, 'redlock', {
      value: {
        acquire: jest.fn().mockResolvedValue({
          release: jest.fn().mockResolvedValue(undefined),
        }),
      },
    });
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

  it('classifies an occupied cold-cache outcome as an already reserved seat', async () => {
    const { service, redis } = createService([[null, 'WAIT']]);
    redis.get.mockResolvedValueOnce('OCCUPIED');
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

  it('does not leave a long-lived hold when cold-cache enqueue fails', async () => {
    const { service, redis, prisma, tracker } = createService([[null, 'MISS']]);
    allowLock(service);
    prisma.seat.findUnique.mockResolvedValueOnce({ status: 'AVAILABLE' });
    tracker.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));

    const pending = service.reserveSeat('user-1', { seatId: 'seat-1' });
    await flush(service);

    await expect(pending).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      errorCode: 'RESERVATION_QUEUE_UNAVAILABLE',
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('returns the accepted reservation when post-enqueue cache sync fails', async () => {
    const { service, redis, prisma, tracker } = createService([[null, 'MISS']]);
    allowLock(service);
    prisma.seat.findUnique.mockResolvedValueOnce({ status: 'AVAILABLE' });
    redis.set.mockRejectedValueOnce(new Error('cache unavailable'));
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();

    const pending = service.reserveSeat('user-1', { seatId: 'seat-1' });
    await flush(service);

    await expect(pending).resolves.toMatchObject({
      userId: 'user-1',
      seatId: 'seat-1',
      status: 'PENDING',
    });
    expect(tracker.enqueue).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(
      'seat:seat-1:status',
      'HELD',
      'EX',
      600,
    );
    expect(tracker.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      redis.set.mock.invocationCallOrder[0],
    );
    expect(log).toHaveBeenCalledWith(
      'Reservation cache synchronization failed after queue enqueue',
    );
  });

  it('preserves the processing payload when acknowledgement fails after commit', async () => {
    const data = {
      id: 'reservation-1',
      userId: 'user-1',
      seatId: 'seat-1',
      reservedAt: new Date().toISOString(),
    };
    const message = {
      streamId: '1-0',
      reservationId: data.id,
      payload: JSON.stringify(data),
      deliveryCount: 1,
      reclaimed: false,
    };
    const prisma = {
      $transaction: jest.fn().mockResolvedValue(undefined),
    };
    const tracker = {
      claimNext: jest.fn().mockResolvedValue(message),
      markProcessingStarted: jest.fn().mockResolvedValue(undefined),
      markSuccess: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      markFailure: jest.fn().mockResolvedValue(undefined),
      markRetry: jest.fn().mockResolvedValue(undefined),
    };
    const processedCounter = {
      inc: jest.fn(),
      labels: jest.fn().mockReturnThis(),
    };
    const service = new ReservationService(
      prisma as never,
      {} as never,
      counter as never,
      counter as never,
      counter as never,
      processedCounter as never,
      tracker as never,
    );
    const log = jest.spyOn(console, 'error').mockImplementation();

    await expect(service.processNextReservation()).resolves.toBe(false);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tracker.markSuccess).toHaveBeenCalledWith(message, data);
    expect(tracker.markFailure).not.toHaveBeenCalled();
    expect(processedCounter.labels).toHaveBeenCalledWith('fail');
    expect(processedCounter.inc).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Failed to process reservation');
  });

  it('retries at max delivery when the reservation outcome is unknown', async () => {
    const data = {
      id: 'reservation-1',
      userId: 'user-1',
      seatId: 'seat-1',
      reservedAt: new Date().toISOString(),
    };
    const message = {
      streamId: '1-0',
      reservationId: data.id,
      payload: JSON.stringify(data),
      deliveryCount: 3,
      reclaimed: false,
    };
    const reconciliationError = new Error('database read unavailable');
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValue(new ConflictException('seat conflict')),
      reservation: {
        findUnique: jest.fn().mockRejectedValue(reconciliationError),
      },
    };
    const tracker = {
      claimNext: jest.fn().mockResolvedValue(message),
      markProcessingStarted: jest.fn().mockResolvedValue(undefined),
      markSuccess: jest.fn().mockResolvedValue(undefined),
      markFailure: jest.fn().mockResolvedValue(undefined),
      markRetry: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReservationService(
      prisma as never,
      {} as never,
      counter as never,
      counter as never,
      counter as never,
      counter as never,
      tracker as never,
    );
    jest.spyOn(console, 'error').mockImplementation();

    await expect(service.processNextReservation()).resolves.toBe(false);

    expect(prisma.reservation.findUnique).toHaveBeenCalledWith({
      where: { id: data.id },
    });
    expect(tracker.markRetry).toHaveBeenCalledWith(
      message,
      data,
      'OUTCOME_UNKNOWN',
    );
    expect(tracker.markFailure).not.toHaveBeenCalled();
    expect(tracker.markSuccess).not.toHaveBeenCalled();
  });
});
