import { ReservationScheduler } from './reservation.scheduler';

describe('ReservationScheduler metrics', () => {
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
      metrics as never,
    );

    await scheduler.handleReservationQueue();

    expect(metrics.observeSchedulerBatch).toHaveBeenCalledWith(
      2,
      expect.any(Number),
    );
  });
});
