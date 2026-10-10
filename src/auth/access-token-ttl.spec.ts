import { readAccessTokenTtlSeconds } from './access-token-ttl';

describe('readAccessTokenTtlSeconds', () => {
  it('uses one hour unless an isolated test environment opts in', () => {
    expect(readAccessTokenTtlSeconds({})).toBe(3600);
    expect(
      readAccessTokenTtlSeconds({
        NODE_ENV: 'test',
        ENABLE_TEST_PREFLIGHT: 'true',
        TEST_ENVIRONMENT: 'local-disposable',
        K6_ACCESS_TOKEN_TTL_SECONDS: '7200',
      }),
    ).toBe(7200);
  });

  it('rejects test TTL overrides in production and shared environments', () => {
    expect(() =>
      readAccessTokenTtlSeconds({
        NODE_ENV: 'production',
        ENABLE_TEST_PREFLIGHT: 'true',
        TEST_ENVIRONMENT: 'local-disposable',
        K6_ACCESS_TOKEN_TTL_SECONDS: '7200',
      }),
    ).toThrow(/forbidden/);
    expect(() =>
      readAccessTokenTtlSeconds({
        NODE_ENV: 'test',
        ENABLE_TEST_PREFLIGHT: 'true',
        TEST_ENVIRONMENT: 'staging',
        K6_ACCESS_TOKEN_TTL_SECONDS: '7200',
      }),
    ).toThrow(/forbidden/);
  });
});
