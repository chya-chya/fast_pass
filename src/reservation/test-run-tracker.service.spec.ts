import { BadRequestException } from '@nestjs/common';
import calculateSlot from 'cluster-key-slot';
import {
  LEGACY_RESERVATION_LISTS,
  RESERVATION_CONSUMER_GROUP,
  ReservationClaimOwnershipError,
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
      command: jest.fn().mockResolvedValue([['xautoclaim']]),
      llen: jest.fn().mockResolvedValue(0),
      xgroup: jest.fn().mockResolvedValue('OK'),
      xautoclaim: jest.fn().mockResolvedValue(['0-0', []]),
      xpending: jest.fn().mockResolvedValue([]),
      xreadgroup: jest.fn().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue(null),
      eval: jest.fn().mockResolvedValue(1),
      pipelineCommands: pipeline,
    };
  }

  it('accepts Redis with XAUTOCLAIM when every legacy list is drained', async () => {
    configureEnvironment();
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(redis.command).toHaveBeenCalledWith('INFO', 'XAUTOCLAIM');
    LEGACY_RESERVATION_LISTS.forEach((key, index) => {
      expect(redis.llen).toHaveBeenNthCalledWith(index + 1, key);
    });
  });

  it('rejects Redis versions without XAUTOCLAIM support', async () => {
    configureEnvironment();
    const redis = redisMock();
    redis.command.mockResolvedValue([null]);
    const service = new TestRunTrackerService(redis as never);

    await expect(service.onModuleInit()).rejects.toThrow(
      'Redis 6.2+ with XAUTOCLAIM support is required',
    );
    expect(redis.llen).not.toHaveBeenCalled();
  });

  it('rejects startup while a legacy reservation list has backlog', async () => {
    configureEnvironment();
    const redis = redisMock();
    redis.llen.mockImplementation((key: string) =>
      Promise.resolve(key === '{queue:reservations}:processing' ? 2 : 0),
    );
    const service = new TestRunTrackerService(redis as never);

    await expect(service.onModuleInit()).rejects.toThrow(
      'legacy reservation queues must be drained before stream activation: {queue:reservations}:processing=2',
    );
  });

  it('caches capability success, reruns backlog checks, and retries capability failures', async () => {
    configureEnvironment();
    const redis = redisMock();
    redis.command
      .mockResolvedValueOnce([null])
      .mockResolvedValueOnce([['xautoclaim']]);
    const service = new TestRunTrackerService(redis as never);

    await expect(service.onModuleInit()).rejects.toThrow(
      'Redis 6.2+ with XAUTOCLAIM support is required',
    );
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.claimNext()).resolves.toBeNull();

    expect(redis.command).toHaveBeenCalledTimes(2);
    expect(redis.llen).toHaveBeenCalledTimes(
      LEGACY_RESERVATION_LISTS.length * 2,
    );
  });

  it('caches capability success but checks every legacy list on later startup calls', async () => {
    configureEnvironment();
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.onModuleInit()).resolves.toBeUndefined();

    expect(redis.command).toHaveBeenCalledTimes(1);
    expect(redis.llen).toHaveBeenCalledTimes(
      LEGACY_RESERVATION_LISTS.length * 2,
    );
  });

  it('blocks enqueue when a legacy backlog appears after startup', async () => {
    configureEnvironment();
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    redis.llen.mockImplementation((key: string) =>
      Promise.resolve(key === 'queue:reservations' ? 1 : 0),
    );

    await expect(
      service.enqueue({
        id: 'reservation-1',
        userId: 'user-1',
        seatId: 'seat-1',
        reservedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow(
      'legacy reservation queues must be drained before stream activation: queue:reservations=1',
    );
    expect(redis.command).toHaveBeenCalledTimes(1);
    expect(redis.pipeline).not.toHaveBeenCalled();
    expect(redis.pipelineCommands.xadd).not.toHaveBeenCalled();
  });

  it('blocks claims when a legacy backlog appears after startup', async () => {
    configureEnvironment();
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    redis.llen.mockImplementation((key: string) =>
      Promise.resolve(key === '{queue:reservations}:retry' ? 1 : 0),
    );

    await expect(service.claimNext()).rejects.toThrow(
      'legacy reservation queues must be drained before stream activation: {queue:reservations}:retry=1',
    );
    expect(redis.command).toHaveBeenCalledTimes(1);
    expect(redis.xautoclaim).not.toHaveBeenCalled();
    expect(redis.xreadgroup).not.toHaveBeenCalled();
  });

  it('does not enqueue before the shared readiness check completes', async () => {
    configureEnvironment();
    const redis = redisMock();
    let resolveCapability!: (value: unknown) => void;
    redis.command.mockReturnValue(
      new Promise((resolve) => {
        resolveCapability = resolve;
      }),
    );
    const service = new TestRunTrackerService(redis as never);

    const enqueue = service.enqueue({
      id: 'reservation-1',
      userId: 'user-1',
      seatId: 'seat-1',
      reservedAt: new Date().toISOString(),
    });
    expect(redis.pipeline).not.toHaveBeenCalled();

    resolveCapability([['xautoclaim']]);
    await expect(enqueue).resolves.toBeUndefined();
    expect(redis.pipeline).toHaveBeenCalledTimes(1);
  });

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

  it('validates queued tracking independently from producer admission flags', () => {
    configureEnvironment();
    process.env.NODE_ENV = 'production';
    process.env.ENABLE_TEST_PREFLIGHT = 'false';
    process.env.ALLOW_TEST_DATA_MUTATION = 'false';
    const service = new TestRunTrackerService(redisMock() as never);

    expect(service.normalizeQueueTracking('smoke-run', 'request-1')).toEqual({
      runId: 'smoke-run',
      requestId: 'request-1',
    });
    expect(() =>
      service.normalizeQueueTracking('smoke-run', undefined),
    ).toThrow(BadRequestException);

    process.env.REDIS_KEY_PREFIX = 'wrong:';
    expect(() =>
      service.normalizeQueueTracking('smoke-run', 'request-1'),
    ).toThrow(BadRequestException);
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

  it('rejects reclaim idle values that are too short for a safe heartbeat', async () => {
    configureEnvironment();
    process.env.RESERVATION_RECLAIM_IDLE_MS = '99';
    const redis = redisMock();
    const service = new TestRunTrackerService(redis as never);

    await service.claimNext();

    expect(redis.xautoclaim).toHaveBeenCalledWith(
      RESERVATION_STREAM,
      RESERVATION_CONSUMER_GROUP,
      expect.any(String),
      30000,
      '0-0',
      'COUNT',
      1,
    );
  });

  it('refreshes only its own pending claim and absorbs heartbeat errors', async () => {
    configureEnvironment();
    process.env.RESERVATION_RECLAIM_IDLE_MS = '100';
    jest.useFakeTimers();
    const redis = redisMock();
    redis.eval
      .mockRejectedValueOnce(new Error('redis unavailable'))
      .mockResolvedValueOnce(1);
    const service = new TestRunTrackerService(redis as never);
    const message = {
      streamId: '1-0',
      reservationId: 'reservation-1',
      payload: '{}',
      deliveryCount: 1,
      reclaimed: false,
    };

    try {
      const stop = service.startClaimHeartbeat(message);
      await jest.advanceTimersByTimeAsync(40);
      await expect(stop()).resolves.toBeUndefined();

      expect(redis.eval).toHaveBeenCalledWith(
        expect.stringMatching(
          /redis\.call\('xpending'[\s\S]*pending\[1\]\[2\] ~= ARGV\[2\][\s\S]*redis\.call\('xclaim'/,
        ),
        1,
        RESERVATION_STREAM,
        RESERVATION_CONSUMER_GROUP,
        expect.any(String),
        message.streamId,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails a synchronous ownership assertion when the claim moved', async () => {
    configureEnvironment();
    const redis = redisMock();
    redis.eval.mockResolvedValue(0);
    const service = new TestRunTrackerService(redis as never);

    await expect(
      service.assertClaimOwnership({
        streamId: '1-0',
        reservationId: 'reservation-1',
        payload: '{}',
        deliveryCount: 1,
        reclaimed: false,
      }),
    ).rejects.toBeInstanceOf(ReservationClaimOwnershipError);
  });

  it('persists failure detail and deletes the terminal key with acknowledgement', async () => {
    configureEnvironment();
    const redis = redisMock();
    const message = {
      streamId: '1-0',
      reservationId: 'reservation-1',
      payload: '{not-json',
      deliveryCount: 3,
      reclaimed: true,
    };
    redis.eval
      .mockResolvedValueOnce('FAILURE\u001fPOISON_MESSAGE')
      .mockResolvedValueOnce(1);
    const service = new TestRunTrackerService(redis as never);

    await service.markFailure(message, undefined, 'POISON_MESSAGE');

    expect(redis.eval).toHaveBeenNthCalledWith(
      1,
      expect.not.stringContaining("'EX'"),
      3,
      RESERVATION_STREAM,
      `${RESERVATION_TERMINAL_PREFIX}reservation-1:1-0`,
      RESERVATION_DLQ_STREAM,
      '1-0',
      'FAILURE\u001fPOISON_MESSAGE',
      'reservation-1',
      3,
      'POISON_MESSAGE',
      '{not-json',
      'FAILURE',
      RESERVATION_CONSUMER_GROUP,
      expect.any(String),
    );
    expect(redis.eval).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(
        /redis\.call\('xpending'[\s\S]*pending\[1\]\[2\] ~= ARGV\[3\][\s\S]*redis\.call\('del', KEYS\[2\]\)/,
      ),
      2,
      RESERVATION_STREAM,
      `${RESERVATION_TERMINAL_PREFIX}reservation-1:1-0`,
      RESERVATION_CONSUMER_GROUP,
      '1-0',
      expect.any(String),
    );
  });

  it('rejects terminal creation when another consumer owns the claim', async () => {
    configureEnvironment();
    const redis = redisMock();
    redis.eval.mockResolvedValue('__CLAIM_OWNERSHIP_LOST__');
    const service = new TestRunTrackerService(redis as never);

    await expect(
      service.markFailure(
        {
          streamId: '1-0',
          reservationId: 'reservation-1',
          payload: '{not-json',
          deliveryCount: 2,
          reclaimed: true,
        },
        undefined,
        'POISON_MESSAGE',
      ),
    ).rejects.toBeInstanceOf(ReservationClaimOwnershipError);

    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringMatching(
        /redis\.call\('xpending'[\s\S]*pending\[1\]\[2\] ~= ARGV\[9\][\s\S]*redis\.call\('set'/,
      ),
      3,
      RESERVATION_STREAM,
      `${RESERVATION_TERMINAL_PREFIX}reservation-1:1-0`,
      RESERVATION_DLQ_STREAM,
      '1-0',
      'FAILURE\u001fPOISON_MESSAGE',
      'reservation-1',
      2,
      'POISON_MESSAGE',
      '{not-json',
      'FAILURE',
      RESERVATION_CONSUMER_GROUP,
      expect.any(String),
    );
  });

  it('leaves terminal recovery state when ownership changes before acknowledgement', async () => {
    configureEnvironment();
    const redis = redisMock();
    redis.eval
      .mockResolvedValueOnce('FAILURE\u001fPOISON_MESSAGE')
      .mockResolvedValueOnce('__CLAIM_OWNERSHIP_LOST__');
    const service = new TestRunTrackerService(redis as never);

    await expect(
      service.markFailure(
        {
          streamId: '1-0',
          reservationId: 'reservation-1',
          payload: '{not-json',
          deliveryCount: 2,
          reclaimed: true,
        },
        undefined,
        'POISON_MESSAGE',
      ),
    ).rejects.toBeInstanceOf(ReservationClaimOwnershipError);

    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.stringMatching(
        /redis\.call\('xpending'[\s\S]*return '__CLAIM_OWNERSHIP_LOST__'[\s\S]*redis\.call\('del', KEYS\[2\]\)/,
      ),
      2,
      RESERVATION_STREAM,
      `${RESERVATION_TERMINAL_PREFIX}reservation-1:1-0`,
      RESERVATION_CONSUMER_GROUP,
      '1-0',
      expect.any(String),
    );
  });

  it('reads a persisted terminal failure for pre-database recovery', async () => {
    configureEnvironment();
    const redis = redisMock();
    redis.get.mockResolvedValue('FAILURE\u001fPROCESSING_ERROR');
    const service = new TestRunTrackerService(redis as never);

    await expect(
      service.terminalDecision({
        streamId: '1-0',
        reservationId: 'reservation-1',
        payload: '{}',
        deliveryCount: 4,
        reclaimed: true,
      }),
    ).resolves.toEqual({
      status: 'FAILURE',
      failureCode: 'PROCESSING_ERROR',
    });
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
