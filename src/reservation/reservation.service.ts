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
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';

interface ReservationQueueData {
  userId: string;
  seatId: string;
  id: string;
  reservedAt: string;
  version?: number;
}

@Injectable()
export class ReservationService {
  private redlock: Redlock;

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redisClient: Redis,
    @InjectMetric('reservation_request_total')
    public requestCounter: Counter<string>,
    @InjectMetric('reservation_lock_total') public lockCounter: Counter<string>,
    @InjectMetric('reservation_queue_total')
    public queueCounter: Counter<string>,
    @InjectMetric('reservation_processed_total')
    public processedCounter: Counter<string>,
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
    this.requestCounter.inc();

    const resource = `locks:seats:${seatId}`;
    const ttl = 10000; // 10초 락

    let lock: Lock | undefined;
    try {
      lock = await this.redlock.acquire([resource], ttl);
      this.lockCounter.labels('success').inc();
    } catch {
      this.lockCounter.labels('fail').inc();
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
          // 이때도 버전이 맞는지 확인하는 것이 안전하지만, 단순 상태 동기화 목적이므로 덮어씀
          await this.redisClient.set(statusKey, seat.status, 'EX', 600);
          throw new ConflictException('이미 예약된 좌석입니다. (DB)');
        }
        // 예약 요청 데이터에 version 포함 (선택 사항이나 worker에 전달하면 더 안전)
        // 여기서는 DB 직전 조회를 worker가 다시 하므로 생략 가능하나, 구조상 확장성 고려
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
      this.queueCounter.labels('success').inc();

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
    try {
      const rawData = await this.redisClient.lpop('queue:reservations');
      if (!rawData) return false; // Queue empty

      const data = JSON.parse(rawData) as ReservationQueueData;
      const { userId, seatId, id, reservedAt } = data;

      await this.prisma.$transaction(async (tx) => {
        const seat = await tx.seat.findUnique({ where: { id: seatId } });

        if (!seat) {
          throw new NotFoundException('좌석을 찾을 수 없습니다.');
        }

        if (seat.status !== 'AVAILABLE') {
          throw new ConflictException('DB: 이미 예약된 좌석입니다.');
        }

        // 좌석 상태 변경 (Optimistic Lock)
        // updateMany를 사용하여 where 조건에 비고유 필드(version, status)를 포함
        const { count } = await tx.seat.updateMany({
          where: {
            id: seatId,
            version: seat.version, // 읽어온 버전과 일치해야 함
            status: 'AVAILABLE',
          },
          data: {
            status: 'HELD',
            version: { increment: 1 }, // 버전 증가
          },
        });

        if (count === 0) {
          throw new ConflictException(
            'DB: 좌석 선점 실패 (Optimistic Lock Collision)',
          );
        }

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

      console.log(`Processed reservation ${id} for seat ${seatId}`);
      this.processedCounter.labels('success').inc();
      return true; // Processed one
    } catch (error) {
      // Redis lpop 실패 혹은 트랜잭션 실패 시
      console.error(`Failed to process reservation:`, error);
      this.processedCounter.labels('fail').inc();
      // 복구 로직이 필요하다면 여기에 추가 (예: DLQ)
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

      // 3. Seat 상태 변경 (OCCUPIED) + Version 증가
      await tx.seat.update({
        where: { id: reservation.seatId },
        data: {
          status: 'OCCUPIED',
          version: { increment: 1 },
        },
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

      // 3. Seat 상태 복구 (AVAILABLE) + Version 증가
      await tx.seat.update({
        where: { id: reservation.seatId },
        data: {
          status: 'AVAILABLE',
          version: { increment: 1 },
        },
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
