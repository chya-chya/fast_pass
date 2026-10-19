import { ReservationScheduler } from './reservation.scheduler';
import type { RedlockAbortSignal } from 'redlock';

describe('ReservationScheduler metrics', () => {
  type SchedulerRoutine = (signal: RedlockAbortSignal) => Promise<unknown>;

  const acquiredLock = {
    runExclusive: jest.fn(
      (_resource: string, _duration: number, routine: SchedulerRoutine) =>
        routine(new AbortController().signal).then((value) => ({
          acquired: true as const,
          value,
        })),
    ),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('records successful batch size and elapsed time', async () => {
    const reservationService = {
      processNextReservation: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
    };
    const metrics = { observeSchedulerBatch: jest.fn() };
    const scheduler = new ReservationScheduler(
      reservationService as never,
      acquiredLock as never,
      metrics as never,
    );

    await scheduler.handleReservationQueue();

    expect(metrics.observeSchedulerBatch).toHaveBeenCalledWith(
      2,
      expect.any(Number),
    );
    expect(acquiredLock.runExclusive).not.toHaveBeenCalled();
  });

  it('runs expiration only inside the distributed lock', async () => {
    const reservationService = {
      expireOverdueReservations: jest.fn().mockResolvedValue(3),
    };
    const scheduler = new ReservationScheduler(
      reservationService as never,
      acquiredLock as never,
    );

    await scheduler.handleExpiredReservations();

    expect(acquiredLock.runExclusive).toHaveBeenCalledWith(
      expect.stringContaining('locks:reservation-scheduler:expiration'),
      30_000,
      expect.any(Function),
    );
    expect(reservationService.expireOverdueReservations).toHaveBeenCalledWith(
      expect.any(Date),
      expect.any(AbortSignal),
    );
  });

  it('does not run maintenance when another process owns the lock', async () => {
    const reservationService = {
      syncAvailableSeats: jest.fn(),
    };
    const skippedLock = {
      runExclusive: jest.fn().mockResolvedValue({ acquired: false }),
    };
    const scheduler = new ReservationScheduler(
      reservationService as never,
      skippedLock as never,
    );

    await scheduler.handleSeatSync();

    expect(reservationService.syncAvailableSeats).not.toHaveBeenCalled();
  });
});
