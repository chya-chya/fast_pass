import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRpsVerdict,
  estimateConfirmationRequestBudget,
  estimateExplorationRequestBudget,
  rpsStageIndex,
  rpsStageWindows,
} from '../lib/rps.js';

test('sizes exploration and confirmation request fixtures', () => {
  assert.equal(
    estimateExplorationRequestBudget(
      [100, 300, 500, 1000],
      [5000, 5000, 5000, 5000],
      5000,
    ),
    24000,
  );
  assert.equal(estimateConfirmationRequestBudget(550, 30000), 16500);
});

test('maps elapsed arrival-rate time to the configured stage', () => {
  const windows = rpsStageWindows(
    [100, 300, 500, 1000],
    [5000, 5000, 5000, 5000],
    5000,
  );
  assert.equal(rpsStageIndex(0, windows), 0);
  assert.equal(rpsStageIndex(10000, windows), 1);
  assert.equal(rpsStageIndex(30000, windows), 3);
});

test('keeps exploration, confirmation, and 110 percent verdicts distinct', () => {
  assert.deepEqual(buildRpsVerdict({ rpsTestProfile: 'explore' }, [], 0), {
    kind: 'exploratory',
    status: 'LIMIT_NOT_FOUND',
    regressionStatus: 'NOT_APPLICABLE',
    reasons: [],
    failedMetrics: [],
  });
  assert.equal(
    buildRpsVerdict({ rpsTestProfile: 'explore' }, [], 1).status,
    'LIMIT_FOUND',
  );
  assert.equal(
    buildRpsVerdict({ rpsTestProfile: 'confirm-100' }, [], 0).status,
    'PASS',
  );
  assert.deepEqual(buildRpsVerdict({ rpsTestProfile: 'confirm-110' }, [], 0), {
    kind: 'exploratory-overload',
    status: 'NOT_APPLICABLE',
    limitStatus: 'LIMIT_NOT_FOUND',
    reasons: [],
    failedMetrics: [],
  });
});

test('records the saturation signal behind an RPS verdict', () => {
  assert.deepEqual(
    buildRpsVerdict(
      { rpsTestProfile: 'explore' },
      [
        { metric: 'accepted_duration_ms', threshold: 'p(95)<200' },
        { metric: 'unexpected_error', threshold: 'count==0' },
      ],
      2,
    ),
    {
      kind: 'exploratory',
      status: 'LIMIT_FOUND',
      regressionStatus: 'NOT_APPLICABLE',
      reasons: [
        'DROPPED_ITERATIONS',
        'LATENCY_THRESHOLD_EXCEEDED',
        'REQUEST_QUALITY_THRESHOLD_EXCEEDED',
      ],
      failedMetrics: ['accepted_duration_ms', 'unexpected_error'],
    },
  );
});
