import { NotFoundException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

export const SAFE_TEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/;

export function isDisposableTestEnvironment(): boolean {
  const environment = process.env.TEST_ENVIRONMENT;
  const local = environment === 'local-disposable';
  const remote = environment === 'remote-disposable';
  return (
    (local || remote) &&
    process.env.NODE_ENV !== 'production' &&
    process.env.PRODUCTION !== 'true' &&
    (!remote || process.env.PRODUCTION === 'false')
  );
}

function secureTokenMatches(
  actual: string | undefined,
  expected: string,
): boolean {
  if (!actual || expected.length < 32) return false;
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function assertTestEnvironmentAccess(token?: string): void {
  const expectedToken = process.env.TEST_PREFLIGHT_TOKEN || '';
  if (
    !isDisposableTestEnvironment() ||
    process.env.ENABLE_TEST_PREFLIGHT !== 'true' ||
    process.env.ALLOW_TEST_DATA_MUTATION !== 'true' ||
    !secureTokenMatches(token, expectedToken)
  ) {
    throw new NotFoundException();
  }
}

export function assertSafeTestId(value: string, label: string): void {
  if (!SAFE_TEST_ID_PATTERN.test(value) || value.includes('..')) {
    throw new NotFoundException(`${label} is invalid`);
  }
}

export function testRunRedisBase(runId: string): string {
  assertSafeTestId(runId, 'run ID');
  const prefix = process.env.REDIS_KEY_PREFIX || '';
  const testEnvId = process.env.TEST_ENV_ID || '';
  if (!testEnvId || prefix !== `k6:${testEnvId}:`) {
    throw new NotFoundException();
  }
  return `${prefix}run:${runId}:`;
}
