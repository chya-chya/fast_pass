import { databaseSslRejectUnauthorized } from './prisma.service';

describe('database TLS certificate verification', () => {
  it('preserves the production-compatible default without a CA bundle', () => {
    expect(databaseSslRejectUnauthorized()).toBe(false);
    expect(databaseSslRejectUnauthorized('false')).toBe(false);
  });

  it('enables certificate verification only when explicitly requested', () => {
    expect(databaseSslRejectUnauthorized('true')).toBe(true);
  });
});
