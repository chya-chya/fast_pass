import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOCAL_BASE_URL,
  validateLegacyEnvironment,
} from '../lib/legacy-safety.js';

const safeLocalEnvironment = {
  BASE_URL: LOCAL_BASE_URL,
  TEST_ENVIRONMENT: 'local-disposable',
  TEST_ENV_ID: 'local-k6-001',
  TEST_DATABASE_ID: 'fast-pass-k6-001',
  TEST_REDIS_ID: 'fast-pass-k6-001',
  ALLOW_TEST_DATA_MUTATION: 'true',
};

test('accepts an explicitly identified disposable loopback environment', () => {
  const result = validateLegacyEnvironment(safeLocalEnvironment);
  assert.equal(result.isLocal, true);
  assert.deepEqual(result.errors, []);
});

test('rejects missing environment identity before any request can start', () => {
  const result = validateLegacyEnvironment({});
  assert.equal(result.isLocal, true);
  assert.match(result.errors.join('\n'), /TEST_ENV_ID is required/);
  assert.match(result.errors.join('\n'), /TEST_DATABASE_ID is required/);
  assert.match(result.errors.join('\n'), /TEST_REDIS_ID is required/);
});

test('rejects a remote DNS name even when legacy approval-shaped flags are present', () => {
  const result = validateLegacyEnvironment({
    ...safeLocalEnvironment,
    BASE_URL: 'https://load.example.test',
    TEST_ENVIRONMENT: 'remote-disposable',
    ALLOW_REMOTE_LOAD: 'true',
    REMOTE_APPROVAL_MANIFEST: 'approval.json',
    APPROVED_TARGET_HOST: 'load.example.test',
    APPROVED_TEST_ENV_ID: safeLocalEnvironment.TEST_ENV_ID,
  });

  assert.equal(result.isLocal, false);
  assert.match(result.errors.join('\n'), /remote execution is disabled/);
});

test('rejects public IPs and production-like environment names', () => {
  const result = validateLegacyEnvironment({
    ...safeLocalEnvironment,
    BASE_URL: 'http://203.0.113.10',
    TEST_ENVIRONMENT: 'production',
  });

  assert.equal(result.isLocal, false);
  assert.match(
    result.errors.join('\n'),
    /production environments are forbidden/,
  );
});
