import { NotFoundException } from '@nestjs/common';
import { TestEnvironmentHealthController } from './test-environment-health.controller';

describe('TestEnvironmentHealthController', () => {
  const originalEnvironment = process.env;

  afterEach(() => {
    process.env = originalEnvironment;
  });

  function configureDisposableEnvironment() {
    process.env = {
      ...originalEnvironment,
      NODE_ENV: 'test',
      ENABLE_TEST_PREFLIGHT: 'true',
      TEST_PREFLIGHT_TOKEN: 'p'.repeat(32),
      APP_ID: 'fast_pass',
      APP_BUILD_SHA: 'a'.repeat(40),
      TEST_ENVIRONMENT: 'local-disposable',
      TEST_ENV_ID: 'health-test',
      TEST_DATABASE_NAME: 'fast_pass_k6_health_test',
      TEST_REDIS_ID: 'redis-health-test',
      REDIS_KEY_PREFIX: 'k6:health-test:',
      ALLOW_TEST_DATA_MUTATION: 'true',
      ENABLE_TRACING: 'false',
      OTEL_TRACE_SAMPLE_RATIO: '0.1',
      OTEL_MIN_SPAN_DURATION_MS: '0',
    };
  }

  it('returns only verified safe environment identity fields', async () => {
    configureDisposableEnvironment();
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([
          { name: 'fast_pass_k6_health_test', tls: false },
        ])
        .mockResolvedValueOnce([{ migrationId: '20260105075934' }]),
    };
    const redis = {
      options: {},
      ping: jest.fn().mockResolvedValue('PONG'),
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          testEnvId: 'health-test',
          redisId: 'redis-health-test',
          keyPrefix: 'k6:health-test:',
        }),
      ),
    };
    const controller = new TestEnvironmentHealthController(
      prisma as never,
      redis,
    );

    const response = await controller.testEnvironment('p'.repeat(32));

    expect(response).toEqual({
      appId: 'fast_pass',
      buildSha: 'a'.repeat(40),
      testEnvId: 'health-test',
      database: {
        connected: true,
        name: 'fast_pass_k6_health_test',
        migrationId: '20260105075934',
        tlsMode: 'disable',
      },
      redis: {
        connected: true,
        id: 'redis-health-test',
        keyPrefix: 'k6:health-test:',
        tlsMode: 'disable',
      },
      observability: {
        tracingEnabled: false,
        traceSampleRatio: 0.1,
        minSpanDurationMs: 0,
      },
    });
  });

  it('stays hidden in production even with a matching token', async () => {
    configureDisposableEnvironment();
    process.env.NODE_ENV = 'production';
    const controller = new TestEnvironmentHealthController(
      { $queryRaw: jest.fn() } as never,
      { get: jest.fn(), ping: jest.fn() },
    );

    await expect(
      controller.testEnvironment('p'.repeat(32)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
