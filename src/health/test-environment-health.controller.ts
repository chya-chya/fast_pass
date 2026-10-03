import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
  Headers,
  Header,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { assertTestEnvironmentAccess } from './test-environment-access';

type RedisHealthClient = {
  get(key: string): Promise<string | null>;
  ping(): Promise<string>;
  options?: { tls?: unknown; redisOptions?: { tls?: unknown } };
};

type DatabaseIdentity = {
  name: string;
  tls: boolean;
};

type MigrationIdentity = {
  migrationId: string;
};

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const DATABASE_NAME_PATTERN = /^fast_pass_k6_[a-z0-9_]{3,48}$/;
const BUILD_SHA_PATTERN = /^[a-f0-9]{40}$/;
const MIGRATION_ID_PATTERN = /^[0-9]{14}(?:_[A-Za-z0-9_-]{1,64})?$/;

@Controller('health')
export class TestEnvironmentHealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: RedisHealthClient,
  ) {}

  @Get('test-environment')
  @Header('Cache-Control', 'no-store')
  async testEnvironment(@Headers('x-test-preflight-token') token?: string) {
    assertTestEnvironmentAccess(token);

    const appId = process.env.APP_ID || 'fast_pass';
    const buildSha = process.env.APP_BUILD_SHA || '';
    const testEnvId = process.env.TEST_ENV_ID || '';
    const testDatabaseName = process.env.TEST_DATABASE_NAME || '';
    const testRedisId = process.env.TEST_REDIS_ID || '';
    const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || '';
    const normalizedEnvId = testEnvId.toLowerCase().replace(/[.-]/g, '_');

    if (
      process.env.TEST_ENVIRONMENT !== 'local-disposable' ||
      process.env.ALLOW_TEST_DATA_MUTATION !== 'true' ||
      !SAFE_ID_PATTERN.test(appId) ||
      !SAFE_ID_PATTERN.test(testEnvId) ||
      !SAFE_ID_PATTERN.test(testRedisId) ||
      !BUILD_SHA_PATTERN.test(buildSha) ||
      !DATABASE_NAME_PATTERN.test(testDatabaseName) ||
      !testDatabaseName.includes(normalizedEnvId) ||
      redisKeyPrefix !== `k6:${testEnvId}:`
    ) {
      throw new ServiceUnavailableException('test environment is not ready');
    }

    try {
      const databaseRows = await this.prisma.$queryRaw<DatabaseIdentity[]>`
        SELECT current_database() AS name,
               COALESCE(
                 (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
                 false
               ) AS tls
      `;
      const migrationRows = await this.prisma.$queryRaw<MigrationIdentity[]>`
        SELECT migration_name AS "migrationId"
        FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY finished_at DESC
        LIMIT 1
      `;
      const database = databaseRows[0];
      const migrationId = migrationRows[0]?.migrationId;
      const ping = await this.redis.ping();
      const markerText = await this.redis.get(`${redisKeyPrefix}environment`);
      const marker = markerText ? JSON.parse(markerText) : null;
      const configuredRedisTls = Boolean(
        this.redis.options?.tls || this.redis.options?.redisOptions?.tls,
      );

      if (
        !database ||
        database.name !== testDatabaseName ||
        !migrationId ||
        !MIGRATION_ID_PATTERN.test(migrationId) ||
        ping !== 'PONG' ||
        !marker ||
        marker.testEnvId !== testEnvId ||
        marker.redisId !== testRedisId ||
        marker.keyPrefix !== redisKeyPrefix
      ) {
        throw new ServiceUnavailableException('test environment is not ready');
      }

      return {
        appId,
        buildSha,
        testEnvId,
        database: {
          connected: true,
          name: database.name,
          migrationId,
          tlsMode: database.tls ? 'require' : 'disable',
        },
        redis: {
          connected: true,
          id: testRedisId,
          keyPrefix: redisKeyPrefix,
          tlsMode: configuredRedisTls ? 'require' : 'disable',
        },
      };
    } catch (_) {
      throw new ServiceUnavailableException('test environment is not ready');
    }
  }
}
