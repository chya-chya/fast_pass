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

  // Lua Script for atomic reservation
  // KEYS[1]: seat status key (e.g., "seat:1:status")
  // KEYS[2]: reservation queue key (e.g., "queue:reservations")
  // ARGV[1]: reservation data (JSON string)
  // ARGV[2]: TTL for seat status (seconds)
  // Returns:
  // 'OK'   - Success
  // 'FAIL' - Already reserved (in Cache)
  // 'MISS' - Seat status not in cache (need DB check)
  private readonly reservationScript = `
    local status = redis.call('get', KEYS[1])
    if status == false then
      return 'MISS'
    end
    if status ~= 'AVAILABLE' then
      return 'FAIL'
    end
    redis.call('rpush', KEYS[2], ARGV[1])
    redis.call('set', KEYS[1], 'HELD', 'EX', ARGV[2])
    return 'OK'
  `;

  async reserveSeat(
    userId: string,
    createReservationDto: CreateReservationDto,
  ) {
    const { seatId } = createReservationDto;
    this.requestCounter.inc();

    const statusKey = `seat:${seatId}:status`;
    const queueKey = 'queue:reservations';
    const reservationId = crypto.randomUUID();
    const reservationData: ReservationQueueData = {
      id: reservationId,
      userId,
      seatId,
      reservedAt: new Date().toISOString(),
    };

    // 1. Try Lua Script (Fast Path)
    // 캐시에 상태가 있다면 Lock 없이 원자적으로 처리
    try {
      const result = await this.redisClient.eval(
        this.reservationScript,
        2,
        statusKey,
        queueKey,
        JSON.stringify(reservationData),
        600, // 10 minutes TTL
      );

      if (result === 'OK') {
        this.queueCounter.labels('success').inc();
        return {
          ...reservationData,
          reservedAt: new Date(reservationData.reservedAt),
          status: 'PENDING',
        };
      }

      if (result === 'FAIL') {
        throw new ConflictException('이미 예약된 좌석입니다. (Cache)');
      }

      // result === 'MISS' falls through to Slow Path
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      // Redis error, proceed to slow path or rethrow?
      // For robustness, if eval fails, we might want to try the slow path or just error out.
      // Logging and proceeding to slow path is safer if it's a transient script issue,
      // but usually an error here means Redis is down or script is bad.
      console.warn('Redis Lua script failed, falling back to lock:', err);
    }

    // 2. Slow Path (Cache Miss or Fallback)
    // 기존의 Lock -> DB Check -> Cache Update 로직 수행
    const resource = `locks:seats:${seatId}`;
    const ttl = 10000; // 10초 락

    let lock: Lock | undefined;
    try {
      lock = await this.redlock.acquire([resource], ttl);
      this.lockCounter.labels('success').inc();

      // DB Check
      const seat = await this.prisma.seat.findUnique({
        where: { id: seatId },
      });
      if (!seat) throw new NotFoundException('좌석을 찾을 수 없습니다.');

      // Cache Update (DB state is source of truth here)
      if (seat.status !== 'AVAILABLE') {
        // 이미 예약됨 -> 캐시 갱신
        await this.redisClient.set(statusKey, seat.status, 'EX', 600);
        throw new ConflictException('이미 예약된 좌석입니다. (DB)');
      }

      // Seat is AVAILABLE in DB.
      // Now we queue properly.

      // Queue update
      await this.redisClient.rpush(queueKey, JSON.stringify(reservationData));
      this.queueCounter.labels('success').inc();

      // Set Cache to HELD
      await this.redisClient.set(statusKey, 'HELD', 'EX', 600);

      return {
        ...reservationData,
        reservedAt: new Date(reservationData.reservedAt),
        status: 'PENDING',
      };

    } catch (err) {
      if (
        err instanceof ConflictException ||
        err instanceof NotFoundException
      ) {
        throw err;
      }
      this.lockCounter.labels('fail').inc();
      // Redlock error or other unknown
      if (err instanceof Error && err.name === 'ExecutionError') {
        // Redlock fail
        throw new ConflictException('좌석 잠금 획득 실패 - 다시 시도해주세요.');
      }
      throw err;
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
