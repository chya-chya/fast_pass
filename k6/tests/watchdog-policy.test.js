import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateWatchdogViolations,
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
