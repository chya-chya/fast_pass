import { redisClusterTlsOptions } from './redis.module';

describe('Redis Cluster TLS hostname verification', () => {
  it('preserves ElastiCache hostname compatibility by default', () => {
    const options = redisClusterTlsOptions();

    expect(options.checkServerIdentity).toBeDefined();
  });

  it('enables strict hostname verification only when explicitly requested', () => {
    const options = redisClusterTlsOptions('true');

    expect(options.checkServerIdentity).toBeUndefined();
  });
});
