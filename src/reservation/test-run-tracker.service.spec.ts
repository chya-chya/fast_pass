import { BadRequestException } from '@nestjs/common';
import calculateSlot from 'cluster-key-slot';
import {
  RESERVATION_CONSUMER_GROUP,
  RESERVATION_DLQ_STREAM,
  RESERVATION_STREAM,
  RESERVATION_TERMINAL_PREFIX,
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
      xadd: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 1]]),
    };
    return {
      pipeline: jest.fn(() => pipeline),
      xgroup: jest.fn().mockResolvedValue('OK'),
      xautoclaim: jest.fn().mockResolvedValue(['0-0', []]),
      xpending: jest.fn().mockResolvedValue([]),
      xreadgroup: jest.fn().mockResolvedValue(null),
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
      RESERVATION_STREAM,
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

  it('claims new work through a consumer group after checking stale work', async () => {
    configureEnvironment();
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);
    await service.claimNext();
    expect(redis.xgroup).toHaveBeenCalledWith(
      'CREATE',
      RESERVATION_STREAM,
      RESERVATION_CONSUMER_GROUP,
      '0',
      'MKSTREAM',
    );
    expect(redis.xautoclaim).toHaveBeenCalledWith(
      RESERVATION_STREAM,
      RESERVATION_CONSUMER_GROUP,
      expect.any(String),
      30000,
      '0-0',
      'COUNT',
      1,
    );
    expect(redis.xreadgroup).toHaveBeenCalledWith(
      'GROUP',
      RESERVATION_CONSUMER_GROUP,
      expect.any(String),
      'COUNT',
      1,
      'STREAMS',
      RESERVATION_STREAM,
      '>',
    );
  });

  it('continues stale scans from the cursor returned by XAUTOCLAIM', async () => {
    configureEnvironment();
    const redis = redisMock();
    const secondFields = [
      'reservationId',
      'reservation-2',
      'payload',
      '{"id":"reservation-2"}',
    ];
    redis.xautoclaim
      .mockResolvedValueOnce(['5-0', []])
      .mockResolvedValueOnce(['0-0', [['9-0', secondFields]]]);
    redis.xpending.mockResolvedValueOnce([['9-0', 'old-worker', 30000, 3]]);
    const service = new TestRunTrackerService(redis as never);

    await expect(service.claimNext()).resolves.toBeNull();
    await expect(service.claimNext()).resolves.toMatchObject({
      streamId: '9-0',
      deliveryCount: 3,
      reclaimed: true,
    });

    expect(redis.xautoclaim).toHaveBeenNthCalledWith(
      2,
      RESERVATION_STREAM,
      RESERVATION_CONSUMER_GROUP,
      expect.any(String),
      30000,
      '5-0',
      'COUNT',
      1,
    );
  });

  it('keeps every queue key in one Redis Cluster slot', () => {
    const queueKeys = [
      RESERVATION_STREAM,
      RESERVATION_DLQ_STREAM,
      `${RESERVATION_TERMINAL_PREFIX}reservation-1`,
    ];

    expect(new Set(queueKeys.map((key) => calculateSlot(key))).size).toBe(1);
  });
});
