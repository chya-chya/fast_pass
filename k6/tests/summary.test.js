import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSummary } from '../lib/summary.js';

test('keeps only the metric allowlist and threshold outcomes', () => {
  const summary = buildSummary(
    { runId: 'local-smoke-001' },
    {
      metrics: {
        checks: {
          type: 'rate',
          contains: 'default',
          values: { rate: 1, passes: 1, fails: 0 },
          thresholds: { 'rate==1': { ok: true } },
        },
        unexpected_error: {
          type: 'counter',
          contains: 'default',
          values: { count: 0, rate: 0 },
          thresholds: { 'count==0': { ok: true } },
        },
        request_body: {
          values: { password: 1 },
        },
      },
    },
  );

  assert.equal(summary.thresholdPassed, true);
  assert.deepEqual(Object.keys(summary.metrics), [
    'checks',
    'unexpected_error',
  ]);
  assert.equal(JSON.stringify(summary).includes('password'), false);
});

test('reports failed thresholds without copying response data', () => {
  const summary = buildSummary(
    { runId: 'local-smoke-002' },
    {
      metrics: {
        timeout: {
          type: 'counter',
          contains: 'default',
          values: { count: 1 },
          thresholds: { 'count==0': { ok: false } },
        },
      },
    },
  );

  assert.equal(summary.thresholdPassed, false);
  assert.deepEqual(summary.thresholdFailures, [
    { metric: 'timeout', threshold: 'count==0' },
  ]);
});

test('records stage actual RPS and an exploratory capacity verdict', () => {
  const summary = buildSummary(
    {
      runId: 'capacity-summary',
      scenario: 'capacity-vu',
      capacityTargets: [1, 2, 3, 4],
      capacityRampDuration: '1s',
      capacityRampDurationMs: 1000,
      capacityStageHolds: ['2s', '2s', '2s', '2s'],
      capacityStageHoldMs: [2000, 2000, 2000, 2000],
      capacityProfile: 'unique-seat',
      capacityUserBehavior: 'reserve-then-think',
      capacityThinkTime: '1s',
      capacityRequestBudget: 64,
    },
    {
      metrics: {
        capacity_stage_1_requests: {
          type: 'counter',
          contains: 'default',
          values: { count: 6, rate: 2 },
          thresholds: {},
        },
      },
    },
  );
  assert.equal(summary.capacityStages[0].actualRps, 2);
  assert.deepEqual(summary.verdict, {
    kind: 'exploratory',
    status: 'NOT_APPLICABLE',
    sloThresholdsPassed: true,
  });
});

test('separates offered, started, completed, and dropped RPS', () => {
  const summary = buildSummary(
    {
      runId: 'rps-summary',
      scenario: 'capacity-rps',
      rpsTestProfile: 'explore',
      rpsTimeUnit: '1s',
      rpsTargets: [1, 2, 3, 4],
      rpsRampDuration: '1s',
      rpsRampDurationMs: 1000,
      rpsStageHolds: ['1s', '1s', '1s', '1s'],
      rpsStageHoldMs: [1000, 1000, 1000, 1000],
      rpsLoadDurationMs: 9000,
      rpsRequestBudget: 64,
      rpsPreAllocatedVus: 4,
      rpsMaxVus: 10,
      capacityProfile: 'unique-seat',
    },
    {
      metrics: {
        reservation_requests_started: {
          type: 'counter',
          contains: 'default',
          values: { count: 9, rate: 1 },
          thresholds: {},
        },
        reservation_responses_completed: {
          type: 'counter',
          contains: 'default',
          values: { count: 8, rate: 0.8 },
          thresholds: {},
        },
        dropped_iterations: {
          type: 'counter',
          contains: 'default',
          values: { count: 1, rate: 0.1 },
          thresholds: {},
        },
      },
    },
  );
  assert.equal(summary.rpsLoad.offeredIterations, 10);
  assert.equal(summary.rpsLoad.startedReservationRequests, 9);
  assert.equal(summary.rpsLoad.completedResponses, 8);
  assert.equal(summary.rpsLoad.droppedIterations, 1);
  assert.equal(summary.verdict.status, 'LIMIT_FOUND');
  assert.equal(summary.verdict.regressionStatus, 'NOT_APPLICABLE');
});

test('keeps six independent Soak SLO windows', () => {
  const metrics = {
    load_requests_started: {
      type: 'counter',
      contains: 'default',
      values: { count: 60 },
      thresholds: {},
    },
    load_responses_completed: {
      type: 'counter',
      contains: 'default',
      values: { count: 60 },
      thresholds: {},
    },
  };
  for (let index = 1; index <= 6; index += 1) {
    metrics[`soak_window_${index}_requests_started`] = {
      type: 'counter',
      contains: 'default',
      values: { count: 10 },
      thresholds: {},
    };
    metrics[`soak_window_${index}_responses_completed`] = {
      type: 'counter',
      contains: 'default',
      values: { count: 10 },
      thresholds: {},
    };
    metrics[`soak_window_${index}_accepted_duration_ms`] = {
      type: 'trend',
      contains: 'time',
      values: { 'p(95)': 100 + index, 'p(99)': 200 + index },
      thresholds: { 'p(95)<200': { ok: true }, 'p(99)<500': { ok: true } },
    };
  }

  const summary = buildSummary(
    {
      runId: 'soak-summary',
      scenario: 'soak',
      soakDurationMs: 3600000,
      soakRps: 10,
      loadDurationMs: 3600000,
      loadTimeUnit: '1s',
      loadTestReduced: true,
    },
    { metrics },
  );

  assert.equal(summary.soakWindows.length, 6);
  assert.deepEqual(
    summary.soakWindows.map((window) => [
      window.startedAtMs,
      window.endedAtMs,
      window.startedRequests,
      window.acceptedLatency['p(95)'],
    ]),
    [
      [0, 600000, 10, 101],
      [600000, 1200000, 10, 102],
      [1200000, 1800000, 10, 103],
      [1800000, 2400000, 10, 104],
      [2400000, 3000000, 10, 105],
      [3000000, 3600000, 10, 106],
    ],
  );
  assert.equal(summary.verdict.integrationChecksPassed, true);
});
