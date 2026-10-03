import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../lib/config.js';
import {
  finalizeArtifacts,
  initializeArtifacts,
  markIncomplete,
  markPreflightVerified,
  verifyArtifacts,
} from '../tools/artifact-state.mjs';

const resultsRoot = path.resolve('k6/results');

function environment(runId) {
  const testEnvId = 'artifact-test';
  return {
    BASE_URL: 'http://127.0.0.1:3000',
    RUN_ID: runId,
    TEST_ENVIRONMENT: 'local-disposable',
    TEST_ENV_ID: testEnvId,
    TEST_DATABASE_NAME: 'fast_pass_k6_artifact_test',
    TEST_REDIS_ID: 'redis-artifact-test',
    REDIS_KEY_PREFIX: `k6:${testEnvId}:`,
    ALLOW_TEST_DATA_MUTATION: 'true',
    EXPECTED_BUILD_SHA: 'b'.repeat(40),
    EXPECTED_MIGRATION_ID: '20260105075934',
    TEST_PREFLIGHT_TOKEN: 'p'.repeat(32),
  };
}

function validSummary(runId) {
  return {
    schemaVersion: 1,
    runId,
    scenario: 'smoke',
    generatedAt: new Date().toISOString(),
    thresholdPassed: true,
    thresholdFailures: [],
    metrics: {},
  };
}

function validArtifacts(runId) {
  return {
    '.fixture-manifest.json.tmp': {
      schemaVersion: 1,
      runId,
      testEnvId: 'artifact-test',
      userIds: ['user-1'],
      eventIds: ['event-1'],
      performanceIds: ['performance-1'],
      seatIds: ['seat-1'],
      requestIds: ['request-1'],
      reservationIds: ['reservation-1'],
      counts: {
        users: 1,
        events: 1,
        performances: 1,
        seats: 1,
        acceptedReservations: 1,
      },
    },
    '.consistency-audit.json.tmp': {
      schemaVersion: 1,
      runId,
      testEnvId: 'artifact-test',
      drain: { timedOut: false, elapsedMs: 1000 },
      queues: { pending: 0, processing: 0, retry: 0, dlq: 0 },
      counters: { workerInFlight: 0, conservationDifference: 0 },
      database: { reservationCount: 1, distinctSeatCount: 1 },
      ids: {
        acceptedReservationIds: ['reservation-1'],
        persistedReservationIds: ['reservation-1'],
      },
      consistency: { pass: true, reasons: [] },
    },
    '.server-metrics.json.tmp': {
      schemaVersion: 1,
      runId,
      window: {
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      },
      app: { status: 'unavailable', reason: 'collector not configured' },
      database: { status: 'available', reason: null, summary: {} },
      redis: { status: 'available', reason: null, summary: {} },
    },
  };
}

async function writeRequiredTemps(directory, runId) {
  await writeFile(
    path.join(directory, '.summary.json.tmp'),
    `${JSON.stringify(validSummary(runId))}\n`,
  );
  for (const [fileName, value] of Object.entries(validArtifacts(runId))) {
    await writeFile(
      path.join(directory, fileName),
      `${JSON.stringify(value)}\n`,
    );
  }
  await writeFile(
    path.join(directory, '.report.md.tmp'),
    `# k6 Run ${runId}\n\n## 정합성 결과\n\nPASS\n\n## 한계\n\nnone\n\n## 다음 결정\n\ncontinue\n`,
  );
}

test('initializes OPEN artifacts and finalizes only a validated summary', async (t) => {
  const runId = `artifact-test-${process.pid}`;
  const directory = path.join(resultsRoot, runId);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig(environment(runId), { requireExecution: true });

  await initializeArtifacts(config);
  const openMetadata = JSON.parse(
    await readFile(path.join(directory, 'metadata.json'), 'utf8'),
  );
  assert.equal(openMetadata.execution, 'RUNNING');
  assert.equal(openMetadata.artifactSet, 'OPEN');
  assert.equal(openMetadata.preflight, 'PENDING');

  await markPreflightVerified(config);
  await writeRequiredTemps(directory, runId);
  await finalizeArtifacts(config, 'COMPLETED', 'NONE');
  await verifyArtifacts(config);

  const finalMetadataText = await readFile(
    path.join(directory, 'metadata.json'),
    'utf8',
  );
  const finalMetadata = JSON.parse(finalMetadataText);
  const checksums = await readFile(
    path.join(directory, 'checksums.sha256'),
    'utf8',
  );
  assert.equal(finalMetadata.execution, 'COMPLETED');
  assert.equal(finalMetadata.artifactSet, 'FINALIZED');
  assert.equal(finalMetadata.preflight, 'VERIFIED');
  assert.equal(checksums.trim().split('\n').length, 6);
  for (const fileName of finalMetadata.artifacts) {
    assert.match(checksums, new RegExp(`^[a-f0-9]{64}  ${fileName}$`, 'm'));
  }
});

test('marks an interrupted open artifact as incomplete', async (t) => {
  const runId = `artifact-abort-${process.pid}`;
  const directory = path.join(resultsRoot, runId);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig(environment(runId), { requireExecution: true });

  await initializeArtifacts(config);
  await markIncomplete(config, 'ABORTED', 'INTERRUPTED');
  const metadata = JSON.parse(
    await readFile(path.join(directory, 'metadata.json'), 'utf8'),
  );
  assert.equal(metadata.execution, 'ABORTED');
  assert.equal(metadata.artifactSet, 'INCOMPLETE');
});

test('refuses to finalize a summary containing a secret-bearing field', async (t) => {
  const runId = `artifact-secret-${process.pid}`;
  const directory = path.join(resultsRoot, runId);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig(environment(runId), { requireExecution: true });

  await initializeArtifacts(config);
  await markPreflightVerified(config);
  await writeRequiredTemps(directory, runId);
  await writeFile(
    path.join(directory, '.summary.json.tmp'),
    `${JSON.stringify({ ...validSummary(runId), accessToken: 'forbidden' })}\n`,
  );
  await assert.rejects(
    () => finalizeArtifacts(config, 'COMPLETED', 'NONE'),
    /forbidden field/,
  );
});

test('refuses to finalize before preflight verification', async (t) => {
  const runId = `artifact-no-preflight-${process.pid}`;
  const directory = path.join(resultsRoot, runId);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig(environment(runId), { requireExecution: true });

  await initializeArtifacts(config);
  await writeFile(
    path.join(directory, '.summary.json.tmp'),
    `${JSON.stringify(validSummary(runId))}\n`,
  );
  await assert.rejects(
    () => finalizeArtifacts(config, 'COMPLETED', 'NONE'),
    /preflight was not verified/,
  );
});

test('detects checksum mismatch after finalization', async (t) => {
  const runId = `artifact-checksum-${process.pid}`;
  const directory = path.join(resultsRoot, runId);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig(environment(runId), { requireExecution: true });

  await initializeArtifacts(config);
  await markPreflightVerified(config);
  await writeRequiredTemps(directory, runId);
  await finalizeArtifacts(config, 'COMPLETED', 'NONE');
  await writeFile(path.join(directory, 'summary.json'), '{}\n');

  await assert.rejects(() => verifyArtifacts(config), /checksum mismatch/);
});

test('rejects an existing result directory before execution', async (t) => {
  const runId = `no-clobber-${process.pid}`;
  const directory = path.join(resultsRoot, runId);
  await mkdir(directory);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    ['k6/tools/config-cli.mjs', '--validate'],
    {
      cwd: path.resolve('.'),
      env: { ...process.env, ...environment(runId) },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /result directory already exists/);
  assert.doesNotMatch(result.stderr, /p{32}/);
});
