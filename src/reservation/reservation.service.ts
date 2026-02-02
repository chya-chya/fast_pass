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

interface PendingReservation {
  userId: string;
  dto: CreateReservationDto;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
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

  private reservationQueue: PendingReservation[] = [];
  private readonly BATCH_INTERVAL = 10; // ms

  async onModuleInit() {
    setInterval(() => {
      void this.flushQueue();
    }, this.BATCH_INTERVAL);
  }

  // Lua Script for seat locking (Single Key Operation)
  // KEYS[1]: seat status key (e.g., "seat:1:status")
  // ARGV[1]: TTL for seat status (seconds)
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
    redis.call('set', KEYS[1], 'HELD', 'EX', ARGV[1])
    return 'OK'
  `;

  // ... reserveSeat method remains same ...

  private async flushQueue() {
    if (this.reservationQueue.length === 0) return;

    const batch = [...this.reservationQueue];
    this.reservationQueue = [];

    const pipeline = this.redisClient.pipeline();

    // 1. Try to acquire locks for all requests in batch
    batch.forEach((req) => {
      const { seatId } = req.dto;
      const statusKey = `seat:${seatId}:status`;
      const reservationId = crypto.randomUUID();

      // Attach ID to request object for later use
      (req as any).reservationId = reservationId;
      (req as any).reservationData = {
        id: reservationId,
        userId: req.userId,
        seatId,
        reservedAt: new Date().toISOString(),
      };

      pipeline.eval(
        this.reservationScript,
        1, // Number of keys
        statusKey,
        600, // ARGV[1]: TTL
      );
    });

    try {
      const results = await pipeline.exec();
      if (!results) return;

      const successfulReqs: typeof batch = [];
      const pushPipeline = this.redisClient.pipeline();

      results.forEach((result, index) => {
        const [err, response] = result;
        const req = batch[index];

        if (err) {
          console.error(`Redis Pipeline Error for req ${req.userId}:`, err);
          req.reject(
            new ConflictException(`Redis Error: ${err.message}`),
          );
          return;
        }

        if (response === 'OK') {
          // Lock acquired locally, prepare to push to queue
          successfulReqs.push(req);
          pushPipeline.rpush(
            'queue:reservations',
            JSON.stringify((req as any).reservationData),
          );
        } else if (response === 'FAIL') {
          req.reject(new ConflictException('이미 예약된 좌석입니다. (Cache)'));
        } else {
          // MISS case -> Slow Path
           this.reserveSeatSlowPath(
            req.userId,
            req.dto,
            (req as any).reservationId,
          )
            .then(req.resolve)
            .catch(req.reject);
        }
      });

      // 2. Push successful requests to queue in a separate pipeline
      if (successfulReqs.length > 0) {
        const pushResults = await pushPipeline.exec();
        
        pushResults?.forEach((result, index) => {
           const [err] = result;
           const req = successfulReqs[index];
           
           if (err) {
             // CRITICAL: Failed to push to queue after locking seat
             // Ideally we should release the lock here, but TTL handles it eventually.
             // Log error explicitly.
             console.error(`Failed to push reservation to queue for ${req.userId}:`, err);
             req.reject(new ConflictException('System Error: Queue Push Failed'));
           } else {
             this.queueCounter.labels('success').inc();
             req.resolve({
              ...(req as any).reservationData,
              reservedAt: new Date((req as any).reservationData.reservedAt),
              status: 'PENDING',
            });
           }
        });
      }

    } catch (e) {
      console.error('Batch Process Error', e);
      batch.forEach((r) => r.reject(e));
    }
  }

  /* Old Logic Removed from here, moved to reserveSeatSlowPath below */
  
  // 기존 Redlock 로직 (Slow Path)
  private async reserveSeatSlowPath(
    userId: string,
    createReservationDto: CreateReservationDto,
    existingId?: string,
  ) {
    const { seatId } = createReservationDto;
    /*... logic continues ...*/
    const resource = `locks:seats:${seatId}`;
    const ttl = 10000;

    let lock: Lock | undefined;
    try {
      lock = await this.redlock.acquire([resource], ttl);
      this.lockCounter.labels('success').inc();

      // DB Check
      const seat = await this.prisma.seat.findUnique({
        where: { id: seatId },
      });
      if (!seat) throw new NotFoundException('좌석을 찾을 수 없습니다.');

      const statusKey = `seat:${seatId}:status`;
      if (seat.status !== 'AVAILABLE') {
        await this.redisClient.set(statusKey, seat.status, 'EX', 600);
        throw new ConflictException('이미 예약된 좌석입니다. (DB)');
      }

      const reservationId = existingId || crypto.randomUUID();
      const reservationData: ReservationQueueData = {
        id: reservationId,
        userId,
        seatId,
        reservedAt: new Date().toISOString(),
      };

      await this.redisClient.rpush(
        'queue:reservations',
        JSON.stringify(reservationData),
      );
      this.queueCounter.labels('success').inc();

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
      if (err instanceof Error && err.name === 'ExecutionError') {
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

      // Redis 상태도 AVAILABLE로 복구 (재예약 가능하도록)
      // 트랜잭션 외부에서 수행하는 것이 좋지만, 여기서는 편의상 내부에서 비동기 실행 (await X)
      // 단, 트랜잭션 롤백 시 정합성 문제가 생길 수 있으므로, 엄밀히는 트랜잭션 후행 작업이어야 함.
      // 하지만 여기서는 즉시성 위해 수행.
      const statusKey = `seat:${reservation.seatId}:status`;
      this.redisClient.set(statusKey, 'AVAILABLE', 'EX', 600).catch(console.error);

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
