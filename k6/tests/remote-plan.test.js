import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildRemoteExecutionMatrix } from '../tools/remote-plan.mjs';

const exampleUrl = new URL(
  '../remote/remote-approval.example.json',
  import.meta.url,
);

async function approval() {
  return JSON.parse(await readFile(exampleUrl, 'utf8'));
}

test('builds the approved candidate sequence with three 100 percent confirmations', async () => {
  const value = await approval();
  const matrix = buildRemoteExecutionMatrix(
    value,
    new Date('2099-01-01T00:01:00Z'),
  );
  assert.equal(matrix.filter((run) => run.purpose === 'CONFIRM-100').length, 3);
  assert.equal(
    matrix.some((run) => run.purpose === 'OVERLOAD_110_EXPLORATION'),
    false,
  );
  assert.equal(matrix.at(-1).scenario, 'soak');
  assert.ok(matrix.every((run) => run.imageRole === 'candidate'));
  for (const scenario of [
    'smoke',
    'consistency-inventory',
    'capacity-vu',
    'capacity-rps',
    'spike',
    'soak',
  ]) {
    const runs = matrix.filter((run) => run.scenario === scenario);
    assert.ok(runs.length > 0);
    assert.ok(
      runs.every((run) => run.env.FIXTURE_SEED_MODE === 'chunked-bulk'),
    );
    assert.ok(runs.every((run) => Number(run.env.FIXTURE_MAX_SEATS) > 0));
  }
});

test('rejects matrix values that exceed explicit approval caps', async () => {
  const value = await approval();
  value.execution.stableRps = value.limits.maxRps + 1;
  assert.throws(
    () => buildRemoteExecutionMatrix(value, new Date('2099-01-01T00:01:00Z')),
    /exceeds approval/,
  );
});

test('rejects qualifying runs too short for independent CloudWatch observations', async () => {
  const value = await approval();
  value.execution.rpsConfirmationSeconds = 60;
  assert.throws(
    () => buildRemoteExecutionMatrix(value, new Date('2099-01-01T00:01:00Z')),
    /too short for 3 independent one-minute CloudWatch observations/,
  );
});

test('comparison mode schedules the same profile for both immutable images', async () => {
  const value = await approval();
  value.mode = { kind: 'comparison' };
  value.window.endsAt = '2099-01-01T04:00:00Z';
  value.images.baseline = {
    gitSha: '1'.repeat(40),
    digest: `sha256:${'1'.repeat(64)}`,
  };
  const matrix = buildRemoteExecutionMatrix(
    value,
    new Date('2099-01-01T00:01:00Z'),
  );
  const baseline = matrix.filter((run) => run.imageRole === 'baseline');
  const candidate = matrix.filter((run) => run.imageRole === 'candidate');
  assert.equal(baseline.length, candidate.length);
  const comparable = (run) => {
    const env = { ...run.env };
    delete env.CONFIRMED_CAPACITY_RUN_ID;
    return [run.scenario, run.purpose, env];
  };
  assert.deepEqual(baseline.map(comparable), candidate.map(comparable));
});
