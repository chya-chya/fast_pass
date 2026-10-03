import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCleanupPlan } from '../lib/cleanup.js';

function config() {
  return {
    runId: 'cleanup-run',
    testEnvId: 'cleanup-env',
    testEnvironment: 'local-disposable',
    redisKeyPrefix: 'k6:cleanup-env:',
  };
}

function fixture() {
  return {
    schemaVersion: 1,
    runId: 'cleanup-run',
    testEnvId: 'cleanup-env',
    userIds: ['user-2', 'user-1'],
    eventIds: ['event-1'],
    performanceIds: ['performance-1'],
    seatIds: ['seat-2', 'seat-1'],
    reservationIds: ['reservation-1'],
  };
}

test('dry-run plan lists only exact fixture IDs and exact run keys', () => {
  const plan = buildCleanupPlan(config(), fixture());
  assert.equal(plan.mode, 'dry-run');
  assert.deepEqual(plan.database.userIds, ['user-1', 'user-2']);
  assert.deepEqual(plan.database.seatIds, ['seat-1', 'seat-2']);
  assert.ok(
    plan.redis.keys.every(
      (key) =>
        key.startsWith('k6:cleanup-env:run:cleanup-run:') ||
        key === 'seat:seat-1:status' ||
        key === 'seat:seat-2:status' ||
        key === 'locks:seats:seat-1' ||
        key === 'locks:seats:seat-2',
    ),
  );
  assert.ok(plan.redis.keys.every((key) => !key.includes('*')));
});

test('rejects run and environment ownership mismatch', () => {
  assert.throws(
    () => buildCleanupPlan(config(), { ...fixture(), runId: 'other-run' }),
    /ownership boundary/,
  );
  assert.throws(
    () =>
      buildCleanupPlan({ ...config(), testEnvironment: 'staging' }, fixture()),
    /ownership boundary/,
  );
});

test('rejects duplicate or unsafe IDs before any deletion is possible', () => {
  assert.throws(
    () =>
      buildCleanupPlan(config(), {
        ...fixture(),
        userIds: ['duplicate', 'duplicate'],
      }),
    /duplicate IDs/,
  );
  assert.throws(
    () => buildCleanupPlan(config(), { ...fixture(), seatIds: ['../seat'] }),
    /unsafe ID/,
  );
});
