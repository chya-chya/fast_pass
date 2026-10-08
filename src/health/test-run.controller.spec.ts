import { ConflictException, NotFoundException } from '@nestjs/common';
import { TestRunController } from './test-run.controller';

describe('TestRunController', () => {
  const originalEnvironment = process.env;

  afterEach(() => {
    process.env = originalEnvironment;
  });

  function configureEnvironment() {
    process.env = {
      ...originalEnvironment,
      NODE_ENV: 'test',
      ENABLE_TEST_PREFLIGHT: 'true',
      TEST_PREFLIGHT_TOKEN: 'p'.repeat(32),
      TEST_ENVIRONMENT: 'local-disposable',
      TEST_ENV_ID: 'run-test',
      REDIS_KEY_PREFIX: 'k6:run-test:',
      ALLOW_TEST_DATA_MUTATION: 'true',
    };
  }

  function redisMock() {
    return {
      del: jest.fn().mockResolvedValue(1),
      exists: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
      hget: jest.fn().mockResolvedValue('OPEN'),
      hset: jest.fn().mockResolvedValue(1),
      mget: jest.fn().mockResolvedValue(['AVAILABLE']),
      set: jest.fn().mockResolvedValue('OK'),
    };
  }

  function storedFixture(redis: ReturnType<typeof redisMock>): unknown {
    const calls = redis.set.mock.calls as unknown[][];
    const raw = calls[0]?.[1];
    if (typeof raw !== 'string') throw new Error('fixture was not stored');
    return JSON.parse(raw) as unknown;
  }

  it('registers only identifiers under the exact run boundary', async () => {
    configureEnvironment();
    const redis = redisMock();
    const controller = new TestRunController(redis);

    await expect(
      controller.registerFixture('smoke-run', 'p'.repeat(32), {
        userIds: ['user-1'],
        eventId: 'event-1',
        performanceId: 'performance-1',
        seatIds: ['seat-1'],
      }),
    ).resolves.toEqual({ runId: 'smoke-run', producerState: 'OPEN' });

    expect(redis.set).toHaveBeenCalledWith(
      'k6:run-test:run:smoke-run:fixture',
      expect.not.stringContaining('password'),
      'EX',
      86400,
      'NX',
    );
    expect(redis.hset).toHaveBeenCalledWith(
      'k6:run-test:run:smoke-run:state',
      'producer',
      'OPEN',
      'createdAt',
      expect.any(String),
    );
  });

  it('applies a warm profile only to exact registered fixture seats', async () => {
    configureEnvironment();
    const redis = redisMock();
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        scenario: 'consistency-one-seat',
        cacheProfile: 'warm',
        seatIds: ['seat-1'],
      }),
    );
    const controller = new TestRunController(redis);
    await expect(
      controller.applyCacheProfile('consistency-run', 'p'.repeat(32)),
    ).resolves.toMatchObject({
      runId: 'consistency-run',
      cacheProfile: 'warm',
      seatCount: 1,
      verified: true,
    });
    expect(redis.set).toHaveBeenCalledWith(
      'seat:seat-1:status',
      'AVAILABLE',
      'EX',
      600,
    );
    expect(redis.mget).toHaveBeenCalledWith('seat:seat-1:status');
  });

  it('derives exact consistency expectations and rejects uneven inventory', async () => {
    configureEnvironment();
    const redis = redisMock();
    const controller = new TestRunController(redis);
    await controller.registerFixture('consistency-run', 'p'.repeat(32), {
      scenario: 'consistency-inventory',
      cacheProfile: 'cold',
      userIds: ['user-1', 'user-2', 'user-3', 'user-4'],
      eventId: 'event-1',
      performanceId: 'performance-1',
      seatIds: ['seat-1', 'seat-2'],
      requestManifest: {
        schemaVersion: 1,
        totalRequests: 4,
        assignment: 'global_iteration_modulo',
      },
    });
    const stored = storedFixture(redis);
    expect(stored).toMatchObject({
      expectedAccepted: 2,
      expectedConflicts: 2,
      requestsPerSeat: 2,
    });

    await expect(
      controller.registerFixture('uneven-run', 'p'.repeat(32), {
        scenario: 'consistency-inventory',
        cacheProfile: 'warm',
        userIds: ['user-1', 'user-2', 'user-3'],
        eventId: 'event-1',
        performanceId: 'performance-1',
        seatIds: ['seat-1', 'seat-2'],
        requestManifest: {
          schemaVersion: 1,
          totalRequests: 3,
          assignment: 'global_iteration_modulo',
        },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts only the exact two-step rebooking manifest', async () => {
    configureEnvironment();
    const redis = redisMock();
    const controller = new TestRunController(redis);
    await controller.registerFixture('rebooking-run', 'p'.repeat(32), {
      scenario: 'rebooking',
      cacheProfile: 'warm',
      userIds: ['user-1'],
      eventId: 'event-1',
      performanceId: 'performance-1',
      seatIds: ['seat-1'],
      requestManifest: {
        schemaVersion: 1,
        totalRequests: 2,
        assignment: 'rebooking_sequence',
      },
    });
    expect(storedFixture(redis)).toMatchObject({
      expectedAccepted: 2,
      expectedConflicts: 0,
      requestsPerSeat: 2,
    });
  });

  it('registers isolated capacity profiles with a bounded request budget', async () => {
    configureEnvironment();
    const redis = redisMock();
    const controller = new TestRunController(redis);
    await controller.registerFixture('capacity-run', 'p'.repeat(32), {
      scenario: 'capacity-vu',
      capacityProfile: 'unique-seat',
      cacheProfile: 'warm',
      userBehavior: 'reserve-then-think',
      thinkTimeMs: 1000,
      userIds: ['user-1', 'user-2'],
      eventId: 'event-1',
      performanceId: 'performance-1',
      seatIds: ['seat-1', 'seat-2'],
      requestManifest: {
        schemaVersion: 2,
        requestBudget: 2,
        assignment: 'global_iteration_unique_seat',
      },
    });
    expect(storedFixture(redis)).toMatchObject({
      scenario: 'capacity-vu',
      capacityProfile: 'unique-seat',
      thinkTimeMs: 1000,
      requestManifest: { schemaVersion: 2, requestBudget: 2 },
    });

    await expect(
      controller.registerFixture('mixed-run', 'p'.repeat(32), {
        scenario: 'capacity-vu',
        capacityProfile: 'unique-seat',
        cacheProfile: 'warm',
        userBehavior: 'reserve-then-think',
        thinkTimeMs: 1000,
        userIds: ['user-1'],
        eventId: 'event-1',
        performanceId: 'performance-1',
        seatIds: ['seat-1'],
        requestManifest: {
          schemaVersion: 2,
          requestBudget: 2,
          assignment: 'global_iteration_hot_seat',
        },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects duplicate fixture IDs and existing runs', async () => {
    configureEnvironment();
    const redis = redisMock();
    const controller = new TestRunController(redis);
    await expect(
      controller.registerFixture('smoke-run', 'p'.repeat(32), {
        userIds: ['user-1', 'user-1'],
        eventId: 'event-1',
        performanceId: 'performance-1',
        seatIds: ['seat-1'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    redis.set.mockResolvedValueOnce(null);
    await expect(
      controller.registerFixture('smoke-run', 'p'.repeat(32), {
        userIds: ['user-1'],
        eventId: 'event-1',
        performanceId: 'performance-1',
        seatIds: ['seat-1'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('stays hidden in production and requires an existing open producer', async () => {
    configureEnvironment();
    const redis = redisMock();
    const controller = new TestRunController(redis);
    process.env.NODE_ENV = 'production';
    await expect(
      controller.producerComplete('smoke-run', 'p'.repeat(32)),
    ).rejects.toBeInstanceOf(NotFoundException);

    process.env.NODE_ENV = 'test';
    redis.exists.mockResolvedValueOnce(0);
    await expect(
      controller.producerComplete('smoke-run', 'p'.repeat(32)),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
