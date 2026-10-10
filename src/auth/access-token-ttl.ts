const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const MIN_TEST_ACCESS_TOKEN_TTL_SECONDS = 5 * 60;
const MAX_TEST_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export function readAccessTokenTtlSeconds(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.K6_ACCESS_TOKEN_TTL_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  if (
    env.NODE_ENV === 'production' ||
    env.ENABLE_TEST_PREFLIGHT !== 'true' ||
    env.TEST_ENVIRONMENT !== 'local-disposable'
  ) {
    throw new Error('test access token TTL is forbidden in this environment');
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error('test access token TTL is invalid');
  }
  const seconds = Number(raw);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MIN_TEST_ACCESS_TOKEN_TTL_SECONDS ||
    seconds > MAX_TEST_ACCESS_TOKEN_TTL_SECONDS
  ) {
    throw new Error('test access token TTL is outside the safe range');
  }
  return seconds;
}
