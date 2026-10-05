import { BadRequestException } from '@nestjs/common';
import calculateSlot from 'cluster-key-slot';
import {
  RESERVATION_DLQ,
  RESERVATION_PROCESSING_QUEUE,
  RESERVATION_QUEUE,
  RESERVATION_RETRY_QUEUE,
  TestRunTrackerService,
} from './test-run-tracker.service';

describe('TestRunTrackerService', () => {
  const originalEnvironment = process.env;

  afterEach(() => {
    process.env = originalEnvironment;
  });

  function configureEnvironment() {
    process.env = {
      ...originalEnvironment,
      NODE_ENV: 'test',
      ENABLE_TEST_PREFLIGHT: 'true',
      TEST_ENVIRONMENT: 'local-disposable',
      TEST_ENV_ID: 'tracker-test',
      REDIS_KEY_PREFIX: 'k6:tracker-test:',
      ALLOW_TEST_DATA_MUTATION: 'true',
    };
  }

  function redisMock() {
    const pipeline = {
      eval: jest.fn().mockReturnThis(),
      rpush: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 1]]),
    };
    return {
      pipeline: jest.fn(() => pipeline),
      lmove: jest.fn().mockResolvedValue(null),
      pipelineCommands: pipeline,
    };
  }

  it('rejects partial or production tracking headers', () => {
    configureEnvironment();
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);
    expect(() => service.normalizeTracking('smoke-run', undefined)).toThrow(
      BadRequestException,
    );
    process.env.NODE_ENV = 'production';
    expect(() => service.normalizeTracking('smoke-run', 'request-1')).toThrow(
      BadRequestException,
    );
  });

  it('atomically records accepted IDs while enqueueing tracked work', async () => {
    configureEnvironment();
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);
    await service.enqueue({
      id: 'reservation-1',
      userId: 'user-1',
      seatId: 'seat-1',
      reservedAt: new Date().toISOString(),
      runId: 'smoke-run',
      requestId: 'request-1',
    });

    expect(redis.pipelineCommands.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('hset', KEYS[2]"),
      3,
      RESERVATION_QUEUE,
      'k6:tracker-test:run:smoke-run:accepted',
      'k6:tracker-test:run:smoke-run:counters',
      expect.any(String),
      'reservation-1',
      'request-1',
      86400,
    );
  });

  it('records every tracked request once before seat mutation', async () => {
    configureEnvironment();
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);
    await service.recordAttempts([
      {
        id: 'reservation-1',
        userId: 'user-1',
        seatId: 'seat-1',
        reservedAt: new Date().toISOString(),
        runId: 'consistency-run',
        requestId: 'request-1',
      },
    ]);
    expect(redis.pipelineCommands.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('hexists', KEYS[1]"),
      2,
      'k6:tracker-test:run:consistency-run:requests',
      'k6:tracker-test:run:consistency-run:counters',
      'request-1',
      JSON.stringify({ seatId: 'seat-1', userId: 'user-1' }),
      86400,
    );
  });

  it('claims by atomically moving pending work into processing', async () => {
    configureEnvironment();
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);
    await service.claimNext();
    expect(redis.lmove).toHaveBeenCalledWith(
      RESERVATION_QUEUE,
      RESERVATION_PROCESSING_QUEUE,
      'LEFT',
      'RIGHT',
    );
  });

  it('keeps every queue key in the pending queue Redis Cluster slot', () => {
    const queueKeys = [
      RESERVATION_QUEUE,
      RESERVATION_PROCESSING_QUEUE,
      RESERVATION_RETRY_QUEUE,
      RESERVATION_DLQ,
    ];

    expect(new Set(queueKeys.map((key) => calculateSlot(key))).size).toBe(1);
  });
});
