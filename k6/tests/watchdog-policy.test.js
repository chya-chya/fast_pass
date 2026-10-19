import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCloudWatchMetricFresh,
  cloudWatchCodesOverlappingRun,
  CLOUDWATCH_WATCHDOG_CODES,
  CLOUDWATCH_RESOURCE_PERIOD_SECONDS,
  conservativeCpuCreditBalance,
  EC2_BASIC_PERIOD_SECONDS,
  evaluateWatchdogViolations,
  freshCloudWatchCodes,
  hasIndependentCloudWatchCoverage,
  updateViolationCounters,
  WATCHDOG_CODES,
} from '../lib/watchdog-policy.js';

const thresholds = {
  unexpectedErrorRate: 0.01,
  databaseConnectionRatio: 0.85,
  databaseCpuPercent: 90,
  redisCpuPercent: 90,
  redisMemoryPercent: 90,
  eventLoopLagMs: 200,
  generatorCpuPercent: 90,
  queueDepth: 100,
  minimumCpuCreditBalance: 10,
  redisEvictions: 0,
  unhealthyTargets: 0,
  processRestarts: 0,
};

test('maps every watchdog stop condition to an explicit failure code', () => {
  const violations = evaluateWatchdogViolations(
    {
      unexpectedErrorRate: 0.02,
      databaseConnectionRatio: 0.9,
      databaseCpuPercent: 91,
      redisCpuPercent: 91,
      redisMemoryPercent: 91,
      eventLoopLagMs: 201,
      generatorCpuPercent: 91,
      queueDepth: 101,
      redisEvictions: 1,
      processRestarts: 1,
      unhealthyTargets: 1,
      minimumCpuCreditBalance: 9,
    },
    thresholds,
  );
  assert.deepEqual(violations, WATCHDOG_CODES.slice(0, 12));
});

test('aborts only after three consecutive samples and resets recovered inputs', () => {
  let state = {};
  for (let sample = 1; sample <= 2; sample += 1) {
    const result = updateViolationCounters(state, ['EVENT_LOOP_LAG_HIGH'], 3);
    state = result.counts;
    assert.equal(result.abortReason, null);
  }
  const recovered = updateViolationCounters(state, [], 3);
  assert.equal(recovered.counts.EVENT_LOOP_LAG_HIGH, 0);
  const third = updateViolationCounters(state, ['EVENT_LOOP_LAG_HIGH'], 3);
  assert.equal(third.abortReason, 'EVENT_LOOP_LAG_HIGH');
});

test('missing monitoring input uses the same consecutive policy', () => {
  let state = {};
  let result;
  for (let sample = 0; sample < 3; sample += 1) {
    result = updateViolationCounters(state, ['WATCHDOG_INPUT_UNAVAILABLE'], 3);
    state = result.counts;
  }
  assert.equal(result.abortReason, 'WATCHDOG_INPUT_UNAVAILABLE');
});

test('preserves CloudWatch counters while a cached datapoint is reused', () => {
  const previous = { DATABASE_CPU_SATURATED: 1, EVENT_LOOP_LAG_HIGH: 1 };
  const evaluated = WATCHDOG_CODES.filter(
    (code) => !CLOUDWATCH_WATCHDOG_CODES.includes(code),
  );
  const result = updateViolationCounters(
    previous,
    ['DATABASE_CPU_SATURATED'],
    3,
    evaluated,
  );

  assert.equal(result.counts.DATABASE_CPU_SATURATED, 1);
  assert.equal(result.counts.EVENT_LOOP_LAG_HIGH, 0);
  assert.equal(result.abortReason, null);
});

test('updates only CloudWatch counters backed by a newer metric timestamp', () => {
  const previous = {
    DATABASE_CPU_SATURATED: '2026-10-19T00:00:00.000Z',
    REDIS_CPU_SATURATED: '2026-10-19T00:00:00.000Z',
  };
  const current = {
    DATABASE_CPU_SATURATED: '2026-10-19T00:05:00.000Z',
    REDIS_CPU_SATURATED: '2026-10-19T00:00:00.000Z',
  };

  assert.deepEqual(freshCloudWatchCodes(previous, current), [
    'DATABASE_CPU_SATURATED',
  ]);
});

test('does not treat an older CloudWatch datapoint as a fresh sample', () => {
  assert.deepEqual(
    freshCloudWatchCodes(
      { DATABASE_CPU_SATURATED: '2026-10-19T00:05:00.000Z' },
      { DATABASE_CPU_SATURATED: '2026-10-19T00:00:00.000Z' },
    ),
    [],
  );
});

test('estimates a safe t3.small CPU credit lower bound between five-minute datapoints', () => {
  const observedAt = '2026-10-19T00:00:00.000Z';

  assert.equal(
    conservativeCpuCreditBalance(
      20,
      observedAt,
      Date.parse('2026-10-19T00:03:00.000Z'),
    ),
    14,
  );
  assert.equal(
    conservativeCpuCreditBalance(
      5,
      observedAt,
      Date.parse('2026-10-19T00:03:00.000Z'),
    ),
    0,
  );
});

test('evaluates the conservative CPU credit estimate on every live watchdog sample', () => {
  const evaluated = WATCHDOG_CODES.filter(
    (code) => !CLOUDWATCH_WATCHDOG_CODES.includes(code),
  );
  let counts = {};
  let result;
  for (let sample = 0; sample < 3; sample += 1) {
    result = updateViolationCounters(
      counts,
      ['APP_CPU_CREDIT_LOW'],
      3,
      evaluated,
    );
    counts = result.counts;
  }
  assert.equal(result.abortReason, 'APP_CPU_CREDIT_LOW');
});

test('requires every one-minute infrastructure metric to have independent coverage', () => {
  const complete = Object.fromEntries(
    CLOUDWATCH_WATCHDOG_CODES.map((code) => [code, 3]),
  );
  assert.equal(hasIndependentCloudWatchCoverage(complete, 3), true);

  complete.REDIS_MEMORY_SATURATED = 2;
  assert.equal(hasIndependentCloudWatchCoverage(complete, 3), false);
});

test('uses one-minute resource metrics and rejects stale observations', () => {
  assert.equal(CLOUDWATCH_RESOURCE_PERIOD_SECONDS, 60);
  assert.equal(EC2_BASIC_PERIOD_SECONDS, 300);
  const now = Date.parse('2026-10-19T00:03:00.000Z');
  assert.doesNotThrow(() =>
    assertCloudWatchMetricFresh(
      '2026-10-19T00:01:00.000Z',
      now,
      180_000,
      'database CPU',
    ),
  );
  assert.throws(
    () =>
      assertCloudWatchMetricFresh(
        '2026-10-18T23:59:59.000Z',
        now,
        180_000,
        'database CPU',
      ),
    /datapoint is stale/,
  );
});

test('counts only CloudWatch periods that overlap the active run', () => {
  const observations = {
    DATABASE_CPU_SATURATED: '2026-10-19T00:00:00.000Z',
    REDIS_CPU_SATURATED: '2026-10-19T00:01:00.000Z',
  };
  assert.deepEqual(
    cloudWatchCodesOverlappingRun(
      observations,
      ['DATABASE_CPU_SATURATED', 'REDIS_CPU_SATURATED'],
      '2026-10-19T00:01:00.000Z',
    ),
    ['REDIS_CPU_SATURATED'],
  );
});
