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
