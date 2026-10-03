import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ReservationService } from './reservation.service';

describe('Reservation lifecycle authorization', () => {
  const counter = { inc: jest.fn(), labels: jest.fn().mockReturnThis() };

  function createService(
    ownerId = 'owner-1',
    finalStatus: 'CANCELLED' | 'CONFIRMED' = 'CANCELLED',
  ) {
    const reservation = {
      id: 'reservation-1',
      userId: ownerId,
      seatId: 'seat-1',
      status: 'PENDING',
      reservedAt: new Date(),
      paidAt: null,
    };
    const tx = {
      reservation: {
        findUnique: jest.fn().mockResolvedValue(reservation),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...reservation, status: finalStatus }),
      },
      seat: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn((operation) => operation(tx)),
    };
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
    };
    const tracker = { normalizeTracking: jest.fn() };
    const service = new ReservationService(
      prisma as never,
      redis as never,
      counter as never,
      counter as never,
      counter as never,
      counter as never,
      tracker as never,
    );
    return { service, tx, redis };
  }

  it('hides another user reservation and performs no mutation', async () => {
    const { service, tx, redis } = createService();
    await expect(
      service.cancelReservation('reservation-1', 'attacker-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects unsafe reservation IDs before querying storage', async () => {
    const { service, tx } = createService();
    await expect(
      service.cancelReservation('../reservation', 'owner-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.reservation.findUnique).not.toHaveBeenCalled();
  });

  it('commits owner cancellation before restoring the exact cache key', async () => {
    const { service, redis } = createService();
    await expect(
      service.cancelReservation('reservation-1', 'owner-1'),
    ).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(redis.set).toHaveBeenCalledWith(
      'seat:seat-1:status',
      'AVAILABLE',
      'EX',
      600,
    );
  });

  it('requires ownership for confirmation and updates the cache after commit', async () => {
    const unauthorized = createService();
    await expect(
      unauthorized.service.confirmReservation('reservation-1', 'attacker-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(unauthorized.tx.reservation.updateMany).not.toHaveBeenCalled();

    const authorized = createService('owner-1', 'CONFIRMED');
    await expect(
      authorized.service.confirmReservation('reservation-1', 'owner-1'),
    ).resolves.toMatchObject({ status: 'CONFIRMED' });
    expect(authorized.tx.seat.update).toHaveBeenCalledWith({
      where: { id: 'seat-1' },
      data: { status: 'OCCUPIED', version: { increment: 1 } },
    });
    expect(authorized.redis.set).toHaveBeenCalledWith(
      'seat:seat-1:status',
      'OCCUPIED',
      'EX',
      600,
    );
  });
});
