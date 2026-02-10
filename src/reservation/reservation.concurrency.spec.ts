import { Test, TestingModule } from '@nestjs/testing';
import { ReservationService } from './reservation.service';
import { PrismaService } from '../prisma/prisma.service';
import { getToken } from '@willsoto/nestjs-prometheus';
import Redis from 'ioredis';
import { ConflictException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as dotenv from 'dotenv';

dotenv.config();

describe('Reservation Concurrency (Integration)', () => {
  let service: ReservationService;
  let prisma: PrismaService;
  let redis: Redis;

  // Mock Metrics
  const mockCounter = {
    inc: jest.fn(),
    labels: jest.fn().mockReturnThis(),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReservationService,
        PrismaService,
        {
          provide: 'REDIS_CLIENT',
          useValue: new Redis({
            host: process.env.REDIS_HOST || 'localhost',
            port: Number(process.env.REDIS_PORT) || 6379,
          }),
        },
        {
          provide: getToken('reservation_request_total'),
          useValue: mockCounter,
        },
        {
          provide: getToken('reservation_lock_total'),
          useValue: mockCounter,
        },
        {
          provide: getToken('reservation_queue_total'),
          useValue: mockCounter,
        },
        {
          provide: getToken('reservation_processed_total'),
          useValue: mockCounter,
        },
      ],
    }).compile();

    await module.init();

    service = module.get<ReservationService>(ReservationService);
    prisma = module.get<PrismaService>(PrismaService);
    redis = module.get<Redis>('REDIS_CLIENT');
  });

  afterAll(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });

  describe('Concurrent Reservations on Same Seat', () => {
    const performanceId = 'test-perf-' + crypto.randomUUID();
    const seatId = 'test-seat-' + crypto.randomUUID();
    const userIdPrefix = 'user-';

    beforeEach(async () => {
      try {
        const user = await prisma.user.upsert({
          where: { email: 'admin@test.com' },
          update: {},
          create: {
            email: 'admin@test.com',
            password: 'password',
            name: 'Admin'
          }
        });

        await prisma.performance.create({
          data: {
            id: performanceId,
            startAt: new Date(),
            totalSeats: 1,
            availableSeats: 1,
            event: {
              create: {
                title: 'Test Event',
                description: 'desc',
                userId: user.id,
              },
            },
          },
        });

        await prisma.seat.create({
          data: {
            id: seatId,
            performanceId,
            seatNumber: 'A1',
            status: 'AVAILABLE',
            version: 0,
          },
        });

        await redis.set(`seat:${seatId}:status`, 'AVAILABLE');
      } catch (e) {
        console.warn('Test Setup warning:', e);
      }
    });

    it('should only allow one successful reservation out of 10 concurrent requests', async () => {
      const concurrentCount = 10;
      const requests = Array.from({ length: concurrentCount }).map((_, i) =>
        service.reserveSeat(`${userIdPrefix}${i}`, { seatId }),
      );

      const results = await Promise.allSettled(requests);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(concurrentCount - 1);

      rejected.forEach((r: PromiseRejectedResult) => {
        expect(r.reason).toBeInstanceOf(ConflictException);
      });

      const status = await redis.get(`seat:${seatId}:status`);
      expect(status).toBe('HELD');
    }, 10000); // 10s timeout
  });
});

//   K6_WEB_DASHBOARD=true k6 run k6/consistency-test.js