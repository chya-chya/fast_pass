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

test('builds a wildcard-free deterministic range cleanup for remote runs', () => {
  const remoteConfig = {
    ...config(),
    testEnvironment: 'remote-disposable',
    userCount: 1_000_000,
    seatCount: 1_000_000,
  };
  const plan = buildCleanupPlan(remoteConfig, {
    schemaVersion: 2,
    runId: remoteConfig.runId,
    testEnvId: remoteConfig.testEnvId,
    eventId: 'cleanup-run-event',
    performanceId: 'cleanup-run-performance',
    userRange: { kind: 'deterministic-v1', start: 0, count: 1_000_000 },
    seatRange: { kind: 'deterministic-v1', start: 0, count: 1_000_000 },
  });
  assert.equal(plan.database.userRange.count, 1_000_000);
  assert.equal(plan.database.reservationOwnership.value, remoteConfig.runId);
  assert.equal(JSON.stringify(plan).includes('*'), false);
});

test('uses run ownership and compact Redis keys for a remote ID fixture', () => {
  const remoteConfig = {
    ...config(),
    testEnvironment: 'remote-disposable',
  };
  const plan = buildCleanupPlan(remoteConfig, fixture());
  assert.deepEqual(plan.database.reservationOwnership, {
    field: 'testRunId',
    value: remoteConfig.runId,
  });
  assert.ok(
    plan.redis.keys.includes('k6:cleanup-env:run:cleanup-run:attempted_bitmap'),
  );
  assert.ok(
    plan.redis.keys.includes(
      'k6:cleanup-env:run:cleanup-run:terminal_success_bitmap',
    ),
  );
  assert.ok(
    !plan.redis.keys.includes('k6:cleanup-env:run:cleanup-run:requests'),
  );
  assert.equal(JSON.stringify(plan).includes('*'), false);
});
