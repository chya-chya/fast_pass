import {
  BadRequestException,
  Injectable,
  Inject,
  ConflictException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import Redis from 'ioredis';
import Redlock, { Lock } from 'redlock';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import { Counter } from 'prom-client';
import {
  ClaimedReservationMessage,
  TestRunTrackerService,
  TrackedReservationData,
} from './test-run-tracker.service';
import { ApiContractException } from '../common/http/api-contract';
import {
  ReservationDatabaseUnavailableException,
  ReservationLockUnavailableException,
  ReservationQueueUnavailableException,
  ReservationStoreUnavailableException,
  SeatAlreadyReservedException,
  SeatNotFoundException,
} from './reservation.errors';

interface ReservationQueueData extends TrackedReservationData {
  version?: number;
}

export interface AcceptedReservation {
  id: string;
  userId: string;
  seatId: string;
  reservedAt: Date;
  status: 'PENDING';
  requestId?: string;
  runId?: string;
}

interface PendingReservation {
  userId: string;
  dto: CreateReservationDto;
  runId?: string;
  requestId?: string;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

const SAFE_RESERVATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

class PermanentQueueMessageError extends Error {
  constructor(public readonly failureCode: string) {
    super(failureCode);
  }
}

@Injectable()
export class ReservationService {
  private redlock: Redlock;
  private readonly logger = new Logger(ReservationService.name);

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
    private readonly testRunTracker: TestRunTrackerService,
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

  onModuleInit() {
    setInterval(() => {
      void this.flushQueue();
    }, this.BATCH_INTERVAL);
  }

  // Lua Script for seat locking (Single Key Operation)
  // KEYS[1]: seat status key (e.g., "seat:1:status")
  // ARGV[1]: TTL for seat status (seconds)
  // ARGV[2]: TTL for the cold-cache DB-check marker (milliseconds)
  // Returns:
  // 'OK'   - Success
  // 'FAIL' - Already reserved (in Cache)
  // 'MISS' - Seat status not in cache (need DB check)
  // 'WAIT' - Another request owns the cold-cache DB check
  private readonly reservationScript = `
    local status = redis.call('get', KEYS[1])
    if status == false then
      local claimed = redis.call('set', KEYS[1], 'CHECKING', 'PX', ARGV[2], 'NX')
      if claimed then return 'MISS' end
      status = redis.call('get', KEYS[1])
    end
    if status == 'CHECKING' then
      return 'WAIT'
    end
    if status ~= 'AVAILABLE' then
      return 'FAIL'
    end
    redis.call('set', KEYS[1], 'HELD', 'EX', ARGV[1])
    return 'OK'
  `;

  async reserveSeat(
    userId: string,
    createReservationDto: CreateReservationDto,
    testRunId?: string,
    testRequestId?: string,
  ): Promise<AcceptedReservation> {
    const tracking = this.testRunTracker.normalizeTracking(
      testRunId,
      testRequestId,
    );
    this.requestCounter.inc();
    return new Promise<AcceptedReservation>((resolve, reject) => {
      this.reservationQueue.push({
        userId,
        dto: createReservationDto,
        ...tracking,
        resolve,
        reject,
      });

      if (this.reservationQueue.length >= 100) {
        void this.flushQueue();
      }
    });
  }

  // 배치 처리
  private async flushQueue() {
    if (this.reservationQueue.length === 0) return;

    const batch = [...this.reservationQueue];
    this.reservationQueue = [];

    // Materialize immutable IDs before touching seat state so the test-only
    // request manifest can audit every attempted reservation.
    batch.forEach((req) => {
      const { seatId } = req.dto;
      const reservationId = crypto.randomUUID();

      // Attach ID to request object for later use
      (req as any).reservationId = reservationId;
      (req as any).reservationData = {
        id: reservationId,
        userId: req.userId,
        seatId,
        reservedAt: new Date().toISOString(),
        runId: req.runId,
        requestId: req.requestId,
      };
    });

    try {
      await this.testRunTracker.recordAttempts(
        batch.map((req) => (req as any).reservationData),
      );
    } catch {
      batch.forEach((request) =>
        request.reject(new ReservationStoreUnavailableException()),
      );
      return;
    }

    const pipeline = this.redisClient.pipeline();
    // 1. Try to acquire locks for all requests in batch
    batch.forEach((req) => {
      const { seatId } = req.dto;
      const statusKey = `seat:${seatId}:status`;
      pipeline.eval(
        this.reservationScript,
        1, // Number of keys
        statusKey,
        600, // ARGV[1]: TTL
        2000, // ARGV[2]: cold-cache leader marker TTL
      );
    });

    try {
      const results = await pipeline.exec();
      if (!results || results.length !== batch.length) {
        batch.forEach((request) =>
          request.reject(new ReservationStoreUnavailableException()),
        );
        return;
      }

      const successfulReqs: typeof batch = [];

      results.forEach((result, index) => {
        const [err, response] = result;
        const req = batch[index];

        if (err) {
          console.error('Reservation Redis pipeline operation failed');
          req.reject(new ReservationStoreUnavailableException());
          return;
        }

        if (response === 'OK') {
          // Lock acquired locally, prepare to push to queue
          successfulReqs.push(req);
        } else if (response === 'FAIL') {
          req.reject(new SeatAlreadyReservedException());
        } else if (response === 'MISS') {
          // MISS case -> Slow Path
          this.reserveSeatSlowPath(
            req.userId,
            req.dto,
            (req as any).reservationId,
            req.runId,
            req.requestId,
          )
            .then(req.resolve)
            .catch(req.reject);
        } else if (response === 'WAIT') {
          this.waitForColdPathOutcome(req.dto.seatId)
            .then(() => req.reject(new SeatAlreadyReservedException()))
            .catch(req.reject);
        } else {
          req.reject(new ReservationStoreUnavailableException());
        }
      });

      // 2. Push successful requests to queue in a separate pipeline
      if (successfulReqs.length > 0) {
        let pushResults;
        try {
          pushResults = await this.testRunTracker.enqueueMany(
            successfulReqs.map((req) => (req as any).reservationData),
          );
        } catch {
          successfulReqs.forEach((request) =>
            request.reject(new ReservationQueueUnavailableException()),
          );
          return;
        }
        if (!pushResults || pushResults.length !== successfulReqs.length) {
          successfulReqs.forEach((request) =>
            request.reject(new ReservationQueueUnavailableException()),
          );
          return;
        }

        pushResults.forEach((result, index) => {
          const [err] = result;
          const req = successfulReqs[index];

          if (err) {
            // CRITICAL: Failed to push to queue after locking seat
            // Ideally we should release the lock here, but TTL handles it eventually.
            // Log error explicitly.
            console.error('Reservation queue enqueue failed');
            req.reject(new ReservationQueueUnavailableException());
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
    } catch {
      console.error('Reservation Redis batch failed');
      batch.forEach((request) =>
        request.reject(new ReservationStoreUnavailableException()),
      );
    }
  }

  /* Old Logic Removed from here, moved to reserveSeatSlowPath below */
  // 기존 Redlock 로직 (Slow Path)
  private async waitForColdPathOutcome(seatId: string): Promise<void> {
    const statusKey = `seat:${seatId}:status`;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      let status: string | null;
      try {
        status = await this.redisClient.get(statusKey);
      } catch {
        throw new ReservationStoreUnavailableException();
      }
      if (status === 'HELD' || status === 'OCCUPIED') return;
      if (status !== 'CHECKING') {
        throw new ReservationLockUnavailableException();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new ReservationLockUnavailableException();
  }

  private async reserveSeatSlowPath(
    userId: string,
    createReservationDto: CreateReservationDto,
    existingId?: string,
    runId?: string,
    requestId?: string,
  ) {
    const { seatId } = createReservationDto;
    /*... logic continues ...*/
    const resource = `locks:seats:${seatId}`;
    const ttl = 10000;

    let lock: Lock | undefined;
    try {
      try {
        lock = await this.redlock.acquire([resource], ttl);
      } catch {
        this.lockCounter.labels('fail').inc();
        throw new ReservationLockUnavailableException();
      }
      this.lockCounter.labels('success').inc();

      // DB Check
      let seat;
      try {
        seat = await this.prisma.seat.findUnique({
          where: { id: seatId },
        });
      } catch {
        throw new ReservationDatabaseUnavailableException();
      }
      if (!seat) throw new SeatNotFoundException();

      const statusKey = `seat:${seatId}:status`;
      if (seat.status !== 'AVAILABLE') {
        try {
          await this.redisClient.set(statusKey, seat.status, 'EX', 600);
        } catch {
          throw new ReservationStoreUnavailableException();
        }
        throw new SeatAlreadyReservedException();
      }

      const reservationId = existingId || crypto.randomUUID();
      const reservationData: ReservationQueueData = {
        id: reservationId,
        userId,
        seatId,
        reservedAt: new Date().toISOString(),
        runId,
        requestId,
      };

      try {
        await this.testRunTracker.enqueue(reservationData);
      } catch {
        throw new ReservationQueueUnavailableException();
      }
      this.queueCounter.labels('success').inc();

      try {
        await this.redisClient.set(statusKey, 'HELD', 'EX', 600);
      } catch {
        this.logger.error(
          'Reservation cache synchronization failed after queue enqueue',
        );
      }

      return {
        ...reservationData,
        reservedAt: new Date(reservationData.reservedAt),
        status: 'PENDING',
      };
    } catch (err) {
      if (err instanceof ApiContractException) {
        throw err;
      }
      this.lockCounter.labels('fail').inc();
      throw err;
    } finally {
      if (lock) {
        await lock.release().catch(() => {
          console.error('Reservation lock release failed');
        });
      }
    }
  }

  async processNextReservation() {
    let message: ClaimedReservationMessage | null = null;
    let data: ReservationQueueData | undefined;
    let transactionCommitted = false;
    try {
      message = await this.testRunTracker.claimNext();
      if (!message) return false; // Queue empty

      data = this.parseQueueData(message);
      const { userId, seatId, id, reservedAt } = data;
      await this.testRunTracker.markProcessingStarted(message, data);

      try {
        await this.prisma.$transaction(async (tx) => {
          const existing = await tx.reservation.findUnique({
            where: { id },
          });
          if (existing) {
            if (this.matchesQueueData(existing, data!)) return;
            throw new PermanentQueueMessageError('IDEMPOTENCY_CONFLICT');
          }

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

          // 잔여 좌석 감소 로직 제거 (Performance 테이블 락 방지)
          // 별도 스케줄러가 주기적으로 동기화함
        });
      } catch (error) {
        if (error instanceof PermanentQueueMessageError) throw error;
        const existing = await this.prisma.reservation
          .findUnique({ where: { id } })
          .catch(() => null);
        if (!existing) throw error;
        if (!this.matchesQueueData(existing, data)) {
          throw new PermanentQueueMessageError('IDEMPOTENCY_CONFLICT');
        }
      }
      transactionCommitted = true;

      await this.testRunTracker.markSuccess(message, data);
      console.log(`Processed reservation ${id} for seat ${seatId}`);
      this.processedCounter.labels('success').inc();
      return true; // Processed one
    } catch (error) {
      // Redis stream claim 또는 DB transaction 실패 시
      console.error('Failed to process reservation');
      this.processedCounter.labels('fail').inc();
      if (message && !transactionCommitted) {
        const failureCode = this.queueFailureCode(error);
        const maxDeliveries = this.maxQueueDeliveries();
        if (
          error instanceof PermanentQueueMessageError ||
          error instanceof ConflictException ||
          error instanceof NotFoundException ||
          message.deliveryCount >= maxDeliveries
        ) {
          await this.testRunTracker
            .markFailure(message, data, failureCode)
            .catch(() => undefined);
        } else {
          await this.testRunTracker
            .markRetry(message, data, failureCode)
            .catch(() => undefined);
        }
      }
      return false;
    }
  }

  private parseQueueData(
    message: ClaimedReservationMessage,
  ): ReservationQueueData {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message.payload);
    } catch {
      throw new PermanentQueueMessageError('POISON_MESSAGE');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new PermanentQueueMessageError('POISON_MESSAGE');
    }
    const data = parsed as Partial<ReservationQueueData>;
    if (
      typeof data.id !== 'string' ||
      !SAFE_RESERVATION_ID.test(data.id) ||
      (message.reservationId !== undefined &&
        message.reservationId !== data.id) ||
      typeof data.userId !== 'string' ||
      data.userId.length === 0 ||
      typeof data.seatId !== 'string' ||
      data.seatId.length === 0 ||
      typeof data.reservedAt !== 'string' ||
      !Number.isFinite(Date.parse(data.reservedAt))
    ) {
      throw new PermanentQueueMessageError('POISON_MESSAGE');
    }
    return data as ReservationQueueData;
  }

  private matchesQueueData(
    existing: { userId: string; seatId: string; reservedAt: Date },
    data: ReservationQueueData,
  ): boolean {
    return (
      existing.userId === data.userId &&
      existing.seatId === data.seatId &&
      existing.reservedAt.getTime() === new Date(data.reservedAt).getTime()
    );
  }

  private maxQueueDeliveries(): number {
    const configured = Number(process.env.RESERVATION_MAX_DELIVERIES || 3);
    return Number.isInteger(configured) && configured > 0 ? configured : 3;
  }

  private queueFailureCode(error: unknown): string {
    if (error instanceof PermanentQueueMessageError) return error.failureCode;
    if (
      error instanceof ConflictException ||
      error instanceof NotFoundException
    ) {
      return 'DOMAIN_REJECTION';
    }
    return 'PROCESSING_ERROR';
  }

  private assertReservationId(reservationId: string) {
    if (!SAFE_RESERVATION_ID.test(reservationId)) {
      throw new BadRequestException('예약 ID 형식이 올바르지 않습니다.');
    }
  }

  async confirmReservation(reservationId: string, userId: string) {
    this.assertReservationId(reservationId);
    const updatedReservation = await this.prisma.$transaction(async (tx) => {
      // 1. 예약 조회
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });

      if (!reservation || reservation.userId !== userId) {
        throw new NotFoundException('예약을 찾을 수 없습니다.');
      }

      if (reservation.status !== 'PENDING') {
        throw new ConflictException(
          '결제 대기 중인 예약만 확정할 수 있습니다.',
        );
      }

      // 2. Reservation 상태 변경 & paidAt 기록
      const { count } = await tx.reservation.updateMany({
        where: { id: reservationId, userId, status: 'PENDING' },
        data: {
          status: 'CONFIRMED',
          paidAt: new Date(),
        },
      });
      if (count !== 1) {
        throw new ConflictException(
          '결제 대기 중인 예약만 확정할 수 있습니다.',
        );
      }

      // 3. Seat 상태 변경 (OCCUPIED) + Version 증가
      await tx.seat.update({
        where: { id: reservation.seatId },
        data: {
          status: 'OCCUPIED',
          version: { increment: 1 },
        },
      });

      return tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    });
    try {
      await this.redisClient.set(
        `seat:${updatedReservation.seatId}:status`,
        'OCCUPIED',
        'EX',
        600,
      );
    } catch {
      this.logger.error(
        'Reservation cache synchronization failed after confirmation',
      );
    }
    return updatedReservation;
  }

  async cancelReservation(reservationId: string, userId: string) {
    return this.releaseReservation(reservationId, userId);
  }

  private async releaseReservation(reservationId: string, userId?: string) {
    this.assertReservationId(reservationId);
    const updatedReservation = await this.prisma.$transaction(async (tx) => {
      // 1. 예약 및 좌석 정보 조회
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });

      if (!reservation || (userId && reservation.userId !== userId)) {
        throw new NotFoundException('예약을 찾을 수 없습니다.');
      }

      if (reservation.status !== 'PENDING') {
        throw new ConflictException(
          '결제 대기 중인 예약만 취소할 수 있습니다.',
        );
      }

      // 2. Reservation 상태 변경 (CANCELLED)
      const reservationUpdate = await tx.reservation.updateMany({
        where: { id: reservationId, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });
      if (reservationUpdate.count !== 1) {
        throw new ConflictException(
          '결제 대기 중인 예약만 취소할 수 있습니다.',
        );
      }

      // 3. Seat 상태 복구 (AVAILABLE) + Version 증가
      const seatUpdate = await tx.seat.updateMany({
        where: { id: reservation.seatId, status: 'HELD' },
        data: {
          status: 'AVAILABLE',
          version: { increment: 1 },
        },
      });
      if (seatUpdate.count !== 1) {
        throw new ConflictException('예약 좌석 상태를 복구할 수 없습니다.');
      }

      // Performance 잔여 좌석 증가 로직 제거 (Performance 테이블 락 방지)
      // 별도 스케줄러가 주기적으로 동기화함
      return tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    });
    try {
      await this.redisClient.set(
        `seat:${updatedReservation.seatId}:status`,
        'AVAILABLE',
        'EX',
        600,
      );
    } catch {
      this.logger.error(
        'Reservation cache synchronization failed after cancellation',
      );
    }
    return updatedReservation;
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
        await this.releaseReservation(reservation.id);
        count++;
      } catch {
        console.error(`Failed to expire reservation ${reservation.id}`);
      }
    }

    return count;
  }

  // 주기적으로 실행될 잔여 좌석 동기화 로직
  // Performance 테이블의 availableSeats를 실제 Seat 테이블의 status를 기반으로 갱신
  async syncAvailableSeats() {
    // 1. 모든 Performance ID 조회 (혹은 활성 Performance만 조회)
    // 여기서는 간단하게 count 집계가 필요한 Performance들을 찾습니다.
    // groupBy로 성능 최적화: PerformanceId별 AVAILABLE 좌석 수 집계
    const seatCounts = await this.prisma.seat.groupBy({
      by: ['performanceId'],
      where: {
        status: 'AVAILABLE',
      },
      _count: {
        id: true,
      },
    });

    // 2. Performance 테이블 업데이트
    const results = await Promise.allSettled(
      seatCounts.map((group) =>
        this.prisma.performance.update({
          where: { id: group.performanceId },
          data: { availableSeats: group._count.id },
        }),
      ),
    );

    const updatedCount = results.filter((r) => r.status === 'fulfilled').length;

    return updatedCount;
  }
}
