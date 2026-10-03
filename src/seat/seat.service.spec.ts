import { SeatStatus } from '@prisma/client';
import { SeatService } from './seat.service';

describe('SeatService', () => {
  it('returns database seats without waiting for cache warming', async () => {
    const seats = [
      {
        id: 'seat-1',
        performanceId: 'performance-1',
        seatNumber: 'A1',
        status: SeatStatus.AVAILABLE,
        version: 0,
        createdAt: new Date('2026-10-01T00:00:00.000Z'),
        updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      },
    ];
    const seatRepository = {
      findSeats: jest.fn().mockResolvedValue(seats),
    };
    const pipeline = {
      set: jest.fn().mockReturnThis(),
      exec: jest.fn().mockReturnValue(new Promise(() => undefined)),
    };
    const redisClient = {
      pipeline: jest.fn().mockReturnValue(pipeline),
    };
    const service = new SeatService(
      seatRepository as never,
      redisClient as never,
    );

    const resultPromise = service.getSeats('performance-1');
    let result: typeof seats | undefined;
    void resultPromise.then((value) => {
      result = value;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(result).toBe(seats);
    expect(pipeline.set).toHaveBeenCalledWith(
      'seat:seat-1:status',
      SeatStatus.AVAILABLE,
      'PX',
      600000,
      'NX',
    );
    expect(pipeline.exec).toHaveBeenCalledTimes(1);
  });
});
