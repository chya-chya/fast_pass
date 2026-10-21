import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertGeneratorLifetimeHeadroom,
  buildRemoteExecutionMatrix,
  executionEnvelopeSeconds,
  longRunTokenTtlHours,
  validateExecutionEnvelopes,
} from '../tools/remote-plan.mjs';

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
  value.window.endsAt = '2099-01-01T16:00:00Z';
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

test('rejects long runs that exceed the application two-hour token TTL', async () => {
  const value = await approval();
  value.execution.soakDurationSeconds = 5000;
  assert.throws(
    () => buildRemoteExecutionMatrix(value, new Date('2099-01-01T00:01:00Z')),
    /two-hour application access-token TTL/,
  );
});

test('rejects a run envelope that can outlive Redis tracking', async () => {
  const value = await approval();
  value.execution.stableRps = 10000;
  value.limits.maxRps = 10000;
  value.limits.maxRequests = 50000000;
  value.limits.maxFixtureSeats = 50000000;
  value.limits.maxFixtureDatabaseRows = 100000000;
  value.limits.maxFixtureDatabaseBytes = 25000000000;
  value.limits.maxFixtureRedisBytes = 15000000000;
  assert.throws(
    () => buildRemoteExecutionMatrix(value, new Date('2099-01-01T00:01:00Z')),
    /Redis tracking TTL/,
  );
});

test('rejects a role envelope without a one-hour SSM timeout reserve', async () => {
  const value = await approval();
  const matrix = Array.from({ length: 12 }, (_, index) => ({
    runId: `envelope-${index}`,
    imageRole: 'candidate',
    scenario: 'smoke',
    durationSeconds: 6500,
    approvedRequests: 1,
    env: { USER_COUNT: '1', SEAT_COUNT: '1' },
  }));
  assert.throws(
    () =>
      validateExecutionEnvelopes(
        {
          ...value,
          window: { ...value.window, endsAt: '2099-01-02T00:00:00Z' },
        },
        matrix,
        new Date('2099-01-01T00:01:00Z'),
      ),
    /safe SSM timeout/,
  );
});

test('sealed-only resume skips approval-window validation for an empty remaining matrix', async () => {
  const value = await approval();
  assert.doesNotThrow(() =>
    validateExecutionEnvelopes(value, [], new Date('2100-01-01T00:00:00Z')),
  );
});

test('remaining remote runs still require an active approval window', async () => {
  const value = await approval();
  const matrix = buildRemoteExecutionMatrix(
    value,
    new Date('2099-01-01T00:01:00Z'),
    undefined,
    { validateEnvelopes: false },
  );
  assert.throws(
    () =>
      validateExecutionEnvelopes(
        value,
        matrix,
        new Date('2100-01-01T00:00:00Z'),
      ),
    /approval window is not active/,
  );
});

test('long-run token TTL ignores unapproved spike or soak settings', () => {
  const profile = {
    soakDurationSeconds: 20 * 60 * 60,
    spikeBaselineSeconds: 60,
    spikePeakSeconds: 60,
    spikeRecoverySeconds: 60,
  };
  assert.equal(longRunTokenTtlHours(['spike'], profile), 2);
  profile.soakDurationSeconds = 60;
  profile.spikeBaselineSeconds = 8 * 60 * 60;
  assert.equal(longRunTokenTtlHours(['soak'], profile), 2);
});

test('generator lifetime covers the complete remaining matrix envelope', async () => {
  const value = await approval();
  const now = new Date('2099-01-01T00:01:00Z');
  const matrix = buildRemoteExecutionMatrix(value, now, undefined, {
    validateEnvelopes: false,
  });
  assert.doesNotThrow(() =>
    assertGeneratorLifetimeHeadroom(
      value,
      matrix,
      {
        launchTime: new Date(now.getTime() - 60_000).toISOString(),
        maxLifetimeHours: 26,
      },
      now,
    ),
  );
  assert.throws(
    () =>
      assertGeneratorLifetimeHeadroom(
        value,
        matrix,
        {
          launchTime: new Date(
            now.getTime() - 25.9 * 60 * 60 * 1000,
          ).toISOString(),
          maxLifetimeHours: 26,
        },
        now,
      ),
    /remaining lifetime/,
  );
  const comparison = matrix
    .map((run) => ({ ...run, imageRole: 'baseline' }))
    .concat(matrix);
  assert.ok(
    executionEnvelopeSeconds(comparison) > executionEnvelopeSeconds(matrix),
  );
});
