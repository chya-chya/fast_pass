import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, toPublicConfig } from '../lib/config.js';

function validEnvironment(overrides = {}) {
  return {
    BASE_URL: 'http://127.0.0.1:3000',
    RUN_ID: 'local-smoke-001',
    VU: '2',
    RPS: '2',
    DURATION: '5s',
    USER_COUNT: '2',
    SEAT_COUNT: '5',
    TEST_ENVIRONMENT: 'local-disposable',
    TEST_ENV_ID: 'local-k6-001',
    TEST_DATABASE_NAME: 'fast_pass_k6_local_k6_001',
    TEST_REDIS_ID: 'redis-local-k6-001',
    REDIS_KEY_PREFIX: 'k6:local-k6-001:',
    ALLOW_TEST_DATA_MUTATION: 'true',
    EXPECTED_APP_ID: 'fast_pass',
    EXPECTED_BUILD_SHA: 'a'.repeat(40),
    EXPECTED_MIGRATION_ID: '20260105075934',
    EXPECTED_DB_TLS_MODE: 'disable',
    EXPECTED_REDIS_TLS_MODE: 'disable',
    EXPECTED_TRACING_ENABLED: 'false',
    EXPECTED_OTEL_TRACE_SAMPLE_RATIO: '0.1',
    EXPECTED_OTEL_MIN_SPAN_DURATION_MS: '0',
    TEST_PREFLIGHT_TOKEN: 't'.repeat(32),
    ...overrides,
  };
}

test('accepts a fully identified disposable loopback environment', () => {
  const config = loadConfig(validEnvironment(), { requireExecution: true });
  assert.equal(config.runId, 'local-smoke-001');
  assert.equal(config.vus, 2);
  assert.equal(config.resultDir, 'k6/results/local-smoke-001');
});

test('rejects unsafe identifiers and invalid numeric input', () => {
  assert.throws(
    () =>
      loadConfig(validEnvironment({ RUN_ID: '../escape', VU: '6' }), {
        requireExecution: true,
      }),
    /configuration rejected/,
  );
});

test('rejects a remote target even when remote flags are present', () => {
  assert.throws(
    () =>
      loadConfig(
        validEnvironment({
          BASE_URL: 'https://example.invalid',
          ALLOW_REMOTE_LOAD: 'true',
          REMOTE_APPROVAL_MANIFEST: 'approval.json',
        }),
        { requireExecution: true },
      ),
    /remote execution is disabled/,
  );
});

test('rejects malformed loopback addresses and production-like identities', () => {
  assert.throws(
    () =>
      loadConfig(
        validEnvironment({
          BASE_URL: 'http://127.999.1.1:3000',
          TEST_ENV_ID: 'prod-local-001',
          TEST_DATABASE_NAME: 'fast_pass_k6_prod_local_001',
          REDIS_KEY_PREFIX: 'k6:prod-local-001:',
        }),
        { requireExecution: true },
      ),
    /configuration rejected/,
  );
});

test('rejects a preflight token containing control characters', () => {
  assert.throws(
    () =>
      loadConfig(
        validEnvironment({ TEST_PREFLIGHT_TOKEN: `${'p'.repeat(31)}\n` }),
        {
          requireExecution: true,
        },
      ),
    /printable ASCII/,
  );
});

test('rejects database and Redis identities that do not match the test environment', () => {
  assert.throws(
    () =>
      loadConfig(
        validEnvironment({
          TEST_DATABASE_NAME: 'fast_pass',
          REDIS_KEY_PREFIX: 'k6:other:',
        }),
        { requireExecution: true },
      ),
    /dedicated fast_pass_k6/,
  );
});

test('public configuration omits tokens and connection strings', () => {
  const publicConfig = toPublicConfig(
    loadConfig(validEnvironment(), { requireExecution: true }),
  );
  const serialized = JSON.stringify(publicConfig);
  assert.doesNotMatch(serialized, /TEST_PREFLIGHT_TOKEN/i);
  assert.doesNotMatch(serialized, /postgres(?:ql)?:\/\//i);
  assert.doesNotMatch(serialized, /redis(?:s)?:\/\//i);
  assert.equal(publicConfig.remoteExecutionEnabled, false);
  assert.equal(publicConfig.expectedTracingEnabled, false);
  assert.equal(publicConfig.expectedTraceSampleRatio, 0.1);
  assert.equal(publicConfig.expectedMinSpanDurationMs, 0);
});

test('uses the exact 1000-by-50 inventory defaults', () => {
  const env = validEnvironment({
    SCENARIO: 'consistency-inventory',
    RUN_ID: 'inventory-defaults',
    VU: undefined,
    USER_COUNT: undefined,
    SEAT_COUNT: undefined,
    DURATION: undefined,
  });
  const config = loadConfig(env, { requireExecution: true });
  assert.equal(config.vus, 1000);
  assert.equal(config.iterationsPerVu, 1);
  assert.equal(config.seatCount, 50);
  assert.equal(config.requestsPerSeat, 20);
  assert.equal(config.expectedAccepted, 50);
  assert.equal(config.expectedConflicts, 950);
});

test('rejects a non-deterministic inventory distribution', () => {
  assert.throws(
    () =>
      loadConfig(
        validEnvironment({
          SCENARIO: 'consistency-inventory',
          VU: '7',
          USER_COUNT: '7',
          SEAT_COUNT: '3',
        }),
        { requireExecution: true },
      ),
    /evenly divisible/,
  );
});

test('configures rebooking as one iteration containing two accepted requests', () => {
  const config = loadConfig(
    validEnvironment({
      SCENARIO: 'rebooking',
      RUN_ID: 'rebooking-config',
      VU: '1',
      USER_COUNT: '1',
      SEAT_COUNT: '1',
    }),
    { requireExecution: true },
  );
  assert.equal(config.scriptPath, 'k6/scenarios/rebooking.js');
  assert.equal(config.totalIterations, 1);
  assert.equal(config.totalRequests, 2);
  assert.equal(config.expectedAccepted, 2);
  assert.equal(config.expectedConflicts, 0);
});

test('uses four ramping VU stages without a target RPS', () => {
  const config = loadConfig({ SCENARIO: 'capacity-vu' });
  assert.equal(config.executor, 'ramping-vus');
  assert.deepEqual(config.capacityTargets, [100, 500, 1000, 2000]);
  assert.deepEqual(config.capacityStageHolds, ['3m', '3m', '3m', '3m']);
  assert.equal(config.capacityThinkTime, '60s');
  assert.equal(config.rps, null);
  assert.equal(config.capacityRequestBudget, 20000);
});

test('accepts only a bounded reduced local capacity profile', () => {
  const config = loadConfig(
    validEnvironment({
      SCENARIO: 'capacity-vu',
      RUN_ID: 'capacity-local',
      RPS: undefined,
      VU: undefined,
      DURATION: undefined,
      CAPACITY_PROFILE: 'unique-seat',
      CAPACITY_VU_STAGES: '1,2,3,4',
      CAPACITY_RAMP_DURATION: '1s',
      CAPACITY_STAGE_HOLD_1: '2s',
      CAPACITY_STAGE_HOLD_2: '2s',
      CAPACITY_STAGE_HOLD_3: '2s',
      CAPACITY_STAGE_HOLD_4: '2s',
      CAPACITY_THINK_TIME: '1s',
      CAPACITY_REQUEST_BUDGET: '64',
      USER_COUNT: '4',
      SEAT_COUNT: '64',
    }),
    { requireExecution: true },
  );
  assert.equal(config.vus, 4);
  assert.equal(config.capacityRequiredRequestBudget, 38);
  assert.equal(config.seatCount, 64);
});

test('rejects RPS targets and undersized capacity fixtures', () => {
  assert.throws(
    () =>
      loadConfig({
        SCENARIO: 'capacity-vu',
        RPS: '100',
        CAPACITY_REQUEST_BUDGET: '10',
      }),
    /RPS must not be set|must be at least/,
  );
});

test('uses the 100 to 1000 RPS exploration defaults', () => {
  const config = loadConfig({ SCENARIO: 'capacity-rps' });
  assert.equal(config.executor, 'ramping-arrival-rate');
  assert.equal(config.rpsTimeUnit, '1s');
  assert.deepEqual(config.rpsTargets, [100, 300, 500, 1000]);
  assert.equal(config.rpsPreAllocatedVus, 500);
  assert.equal(config.rpsMaxVus, 1000);
  assert.equal(config.rpsRequiredRequestBudget, 24000);
  assert.equal(config.rpsRequestBudget, 25000);
});

test('derives 50, 75, 100, and 110 percent confirmation rates', () => {
  const rates = ['confirm-50', 'confirm-75', 'confirm-100', 'confirm-110'].map(
    (profile) =>
      loadConfig({
        SCENARIO: 'capacity-rps',
        RPS_TEST_PROFILE: profile,
        RPS_RATE: '500',
      }).rpsRate,
  );
  assert.deepEqual(rates, [250, 375, 500, 550]);
});

test('accepts a bounded reduced local RPS exploration profile', () => {
  const config = loadConfig(
    validEnvironment({
      SCENARIO: 'capacity-rps',
      RUN_ID: 'rps-local',
      VU: undefined,
      RPS: undefined,
      DURATION: undefined,
      RPS_TEST_PROFILE: 'explore',
      CAPACITY_PROFILE: 'unique-seat',
      RPS_STAGES: '1,2,3,4',
      RPS_RAMP_DURATION: '1s',
      RPS_STAGE_HOLD_1: '1s',
      RPS_STAGE_HOLD_2: '1s',
      RPS_STAGE_HOLD_3: '1s',
      RPS_STAGE_HOLD_4: '1s',
      RPS_PRE_ALLOCATED_VUS: '4',
      RPS_MAX_VUS: '10',
      RPS_REQUEST_BUDGET: '64',
      USER_COUNT: '10',
      SEAT_COUNT: '64',
    }),
    { requireExecution: true },
  );
  assert.equal(config.rpsMaxRate, 4);
  assert.equal(config.rpsRequiredRequestBudget, 24);
  assert.equal(config.durationMs, 9000);
});

test('rejects non-second time units and invalid RPS VU allocation', () => {
  assert.throws(
    () =>
      loadConfig({
        SCENARIO: 'capacity-rps',
        RPS_TIME_UNIT: '1m',
        RPS_PRE_ALLOCATED_VUS: '1001',
        RPS_MAX_VUS: '1000',
      }),
    /RPS_TIME_UNIT must equal 1s|must be at most/,
  );
});
