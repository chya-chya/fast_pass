import {
  Injectable,
  Inject,
  ConflictException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';
import { CreateReservationDto } from './dto/create-reservation.dto';

@Injectable()
export class ReservationService {
  private redlock: Redlock;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redisClient: Redis,
  ) {
    this.redlock = new Redlock([this.redisClient], {
      driftFactor: 0.01,
      retryCount: 0, // 선착순이므로 재시도 안함 (즉시 실패)
      retryDelay: 200,
      retryJitter: 200,
    });
  }

  async reserveSeat(
    userId: string,
    createReservationDto: CreateReservationDto,
  ) {
    const { seatId } = createReservationDto;
    const resource = `locks:seats:${seatId}`;
    const ttl = 10000; // 10초 락 (결제 대기 시간 고려하여 조정 가능)

    let lock: Lock | undefined;
    try {
      lock = await this.redlock.acquire([resource], ttl);
    } catch {
      // 락 획득 실패
      throw new ConflictException('이미 선택된 좌석입니다. (Lock)');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // 1. 좌석 상태 확인
        const seat = await tx.seat.findUnique({ where: { id: seatId } });
        if (!seat) throw new NotFoundException('좌석을 찾을 수 없습니다.');
        if (seat.status !== 'AVAILABLE') {
          throw new ConflictException('이미 예약된 좌석입니다.');
        }

        // 2. 좌석 상태 변경 (HELD) 및 Optimistic Lock 적용 (Raw Query)
        const updateResult = await tx.$executeRaw`
          UPDATE "Seat"
          SET "status" = 'HELD'::"SeatStatus", "version" = "version" + 1
          WHERE "id" = ${seatId} AND "version" = ${seat.version}
        `;

        if (Number(updateResult) !== 1) {
          throw new ConflictException(
            '좌석 정보가 변경되었습니다. 다시 시도해주세요.',
          );
        }

        // 3. 예약 생성
        const reservation = await tx.reservation.create({
          data: {
            userId,
            seatId,
            status: 'PENDING',
          },
        });

        // 4. 잔여 좌석 감소
        await tx.performance.update({
          where: { id: seat.performanceId },
          data: { availableSeats: { decrement: 1 } },
        });

        return reservation;
      });
    } catch (error) {
      // 트랜잭션 실패 시 처리
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      console.error('Reservation Error:', error);
      throw new InternalServerErrorException(
        '예약 처리 중 오류가 발생했습니다.',
      );
    } finally {
      if (lock) {
        await lock.release().catch((err) => {
          // 락 해제 실패 로그 (TTL로 만료되므로 치명적이지 않음)
          console.error('Lock release failed', err);
        });
      }
    }
  }

  async confirmReservation(reservationId: string) {
    return await this.prisma.$transaction(async (tx) => {
      // 1. 예약 조회
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });

      if (!reservation) {
        throw new NotFoundException('예약을 찾을 수 없습니다.');
      }

      if (reservation.status !== 'PENDING') {
        throw new ConflictException(
          '결제 대기 중인 예약만 확정할 수 있습니다.',
        );
      }

      // 2. Reservation 상태 변경 & paidAt 기록
      const updatedReservation = await tx.reservation.update({
        where: { id: reservationId },
        data: {
          status: 'CONFIRMED',
          paidAt: new Date(),
        },
      });

      // 3. Seat 상태 변경 (OCCUPIED)
      await tx.seat.update({
        where: { id: reservation.seatId },
        data: { status: 'OCCUPIED' },
      });

      return updatedReservation;
    });
  }

  async cancelReservation(reservationId: string) {
    return await this.prisma.$transaction(async (tx) => {
      // 1. 예약 및 좌석 정보 조회
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        include: { seat: true }, // PerformanceId 조회를 위해 seat 포함
      });

      if (!reservation) {
        throw new NotFoundException('예약을 찾을 수 없습니다.');
      }

      if (reservation.status !== 'PENDING') {
        throw new ConflictException(
          '결제 대기 중인 예약만 취소할 수 있습니다.',
        );
      }

      // 2. Reservation 상태 변경 (CANCELLED)
      const updatedReservation = await tx.reservation.update({
        where: { id: reservationId },
        data: { status: 'CANCELLED' },
      });

      // 3. Seat 상태 복구 (AVAILABLE)
      await tx.seat.update({
        where: { id: reservation.seatId },
        data: { status: 'AVAILABLE' },
      });

      // 4. Performance 잔여 좌석 증가
      await tx.performance.update({
        where: { id: reservation.seat.performanceId },
        data: { availableSeats: { increment: 1 } },
      });

      return updatedReservation;
    });
  }

  async expireOverdueReservations(thresholdDate: Date) {
    // 만료 대상 예약 조회
    const overdueReservations = await this.prisma.reservation.findMany({
      where: {
        status: 'PENDING',
        reservedAt: {
          lt: thresholdDate,
        },
      },
      select: { id: true },
    });

    let count = 0;
    for (const reservation of overdueReservations) {
      try {
        await this.cancelReservation(reservation.id);
        count++;
      } catch (error) {
        console.error(`Failed to expire reservation ${reservation.id}:`, error);
      }
    }

    return count;
  }
}
