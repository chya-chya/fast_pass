import {
  Injectable,
  Inject,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';
import { CreateReservationDto } from './dto/create-reservation.dto';

interface ReservationQueueData {
  userId: string;
  seatId: string;
  id: string;
  reservedAt: string;
}

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
    const ttl = 10000; // 10초 락

    let lock: Lock | undefined;
    try {
      lock = await this.redlock.acquire([resource], ttl);
    } catch {
      throw new ConflictException('이미 선택된 좌석입니다. (Lock)');
    }

    try {
      // 1. Redis에서 좌석 상태 확인
      const statusKey = `seat:${seatId}:status`;
      const cachedStatus = await this.redisClient.get(statusKey);

      if (cachedStatus && cachedStatus !== 'AVAILABLE') {
        throw new ConflictException('이미 예약된 좌석입니다. (Cache)');
      }

      // 2. 캐시에 없으면 DB 확인 (최초 1회 warm-up 겸용)
      if (!cachedStatus) {
        const seat = await this.prisma.seat.findUnique({
          where: { id: seatId },
        });
        if (!seat) throw new NotFoundException('좌석을 찾을 수 없습니다.');
        if (seat.status !== 'AVAILABLE') {
          // 상태가 정합하지 않으면 캐시 갱신 후 거절
          await this.redisClient.set(statusKey, seat.status, 'EX', 600);
          throw new ConflictException('이미 예약된 좌석입니다. (DB)');
        }
      }

      // 3. Redis Queue에 예약 요청 추가 (Write-Back)
      const reservationId = crypto.randomUUID();
      const reservationData: ReservationQueueData = {
        id: reservationId,
        userId,
        seatId,
        reservedAt: new Date().toISOString(),
      };

      // 트랜잭션 대신 Redis Pipeline 사용 가능하지만 여기선 순차 처리
      await this.redisClient.rpush(
        'queue:reservations',
        JSON.stringify(reservationData),
      );

      // 4. Redis 좌석 상태 'HELD'로 업데이트 (선점)
      await this.redisClient.set(statusKey, 'HELD', 'EX', 600); // 10분 TTL

      // 사용자에게는 성공 응답 즉시 반환
      return {
        ...reservationData,
        reservedAt: new Date(reservationData.reservedAt),
        status: 'PENDING',
      };
    } finally {
      if (lock) {
        await lock.release().catch((err) => {
          console.error('Lock release failed', err);
        });
      }
    }
  }

  async processNextReservation() {
    const rawData = await this.redisClient.lpop('queue:reservations');
    if (!rawData) return false; // Queue empty

    const data = JSON.parse(rawData) as ReservationQueueData;
    const { userId, seatId, id, reservedAt } = data;

    try {
      await this.prisma.$transaction(async (tx) => {
        const seat = await tx.seat.findUnique({ where: { id: seatId } });

        if (!seat) {
          throw new NotFoundException('좌석을 찾을 수 없습니다.');
        }

        if (seat.status !== 'AVAILABLE') {
          throw new ConflictException('DB: 이미 예약된 좌석입니다.');
        }

        // 좌석 상태 변경

        await tx.seat.update({
          where: { id: seatId },
          data: { status: 'HELD' },
        });

        // 예약 생성

        await tx.reservation.create({
          data: {
            id, // Use UUID from Redis
            userId,
            seatId,
            status: 'PENDING',
            reservedAt: new Date(reservedAt), // Preserve timestamp
          },
        });

        // 잔여 좌석 감소

        await tx.performance.update({
          where: { id: seat.performanceId },
          data: { availableSeats: { decrement: 1 } },
        });
      });
      return true; // Processed one
    } catch (error) {
      console.error(`Failed to process reservation ${id}:`, error);
      await this.redisClient.del(`seat:${seatId}:status`);
      return false;
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
