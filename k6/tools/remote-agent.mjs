#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadConfig } from '../lib/config.js';
import { fetchVersionedRemoteApproval } from './remote-approval-s3.mjs';
import { verifyLocalGates } from './remote-gates.mjs';
import { awsJson, inspectRemoteInfrastructure } from './remote-inventory.mjs';
import {
  assertGeneratorLifetimeHeadroom,
  buildRemoteExecutionMatrix,
  validateExecutionEnvelopes,
} from './remote-plan.mjs';
import { verifyRemoteStorage } from './remote-storage.mjs';
import { recoverRangeOwnedData } from './cleanup.mjs';
import {
  assertResumeScope,
  remoteRunHasEvidence,
  selectRemainingRemoteRuns,
} from './remote-resume.mjs';

const execFileAsync = promisify(execFile);

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function requireRuntimeEnvironment() {
  const required = [
    'REMOTE_APPROVAL_BUCKET',
    'REMOTE_APPROVAL_ID',
    'REMOTE_APPROVAL_VERSION_ID',
    'REMOTE_APPROVAL_CHECKSUM',
    'REMOTE_EXECUTION_TIMESTAMP',
    'REMOTE_IMAGE_ROLE',
    'RUNNER_IMAGE_DIGEST',
    'TEST_PREFLIGHT_TOKEN',
    'FIXTURE_USER_PASSWORD',
    'AUDIT_DATABASE_URL',
  ];
  for (const name of required) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  if (!['baseline', 'candidate'].includes(process.env.REMOTE_IMAGE_ROLE)) {
    throw new Error('REMOTE_IMAGE_ROLE is invalid');
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(process.env.RUNNER_IMAGE_DIGEST)) {
    throw new Error('RUNNER_IMAGE_DIGEST is invalid');
  }
  if (!/^\d{17}$/.test(process.env.REMOTE_EXECUTION_TIMESTAMP)) {
    throw new Error('REMOTE_EXECUTION_TIMESTAMP is invalid');
  }
}

function execute(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) resolve(128);
      else resolve(code ?? 1);
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyPostRecoveryReadiness(env) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const status = await execute('node', ['k6/tools/preflight.mjs'], env);
    if (status === 0) {
      process.stdout.write('post-recovery preflight verified\n');
      return;
    }
    if (attempt < 6) await sleep(10_000);
  }
  throw new Error('post-recovery preflight failed after six attempts');
}

export function isGeneratorRetired(description, sourceInstanceId) {
  const instances = (description.Reservations || []).flatMap(
    (reservation) => reservation.Instances || [],
  );
  if (instances.length === 0) return true;
  const source = instances.find(
    (instance) => instance.InstanceId === sourceInstanceId,
  );
  return ['stopped', 'terminated'].includes(source?.State?.Name);
}

async function verifySourceGeneratorRetired(approval, sourceApproval) {
  const sourceId = sourceApproval?.environment?.loadGeneratorInstanceId;
  const currentId = approval.environment.loadGeneratorInstanceId;
  if (!sourceId || sourceId === currentId) return false;
  let description;
  try {
    description = await awsJson(approval.environment.region, [
      'ec2',
      'describe-instances',
      '--instance-ids',
      sourceId,
    ]);
  } catch (error) {
    if (/InvalidInstanceID\.NotFound/.test(error?.message || '')) return true;
    throw error;
  }
  return isGeneratorRetired(description, sourceId);
}

export function hasExclusiveHostFence(runtime = process.env) {
  return runtime.RECOVERY_HOST_LOCK_PROOF === 'exclusive-v1';
}

export function assertRecoveryProducerFence({
  sameGenerator,
  hostFence,
  sourceRetired,
}) {
  if (
    (sameGenerator && hostFence !== true) ||
    (!sameGenerator && sourceRetired !== true)
  ) {
    throw new Error(
      'resume rejected: previous load generator producer is not fenced',
    );
  }
}

export function buildRunEnvironment(baseEnv, run) {
  return {
    ...baseEnv,
    ...run.env,
    RUN_ID: run.runId,
    SCENARIO: run.scenario,
  };
}

function commonRunEnvironment(approval, verified, inventory, imageRole) {
  const image = approval.images[imageRole];
  const workerMetrics = inventory.appInstances.flatMap((instance) => [
    `http://${instance.privateIp}:9300/metrics`,
    `http://${instance.privateIp}:9301/metrics`,
  ]);
  const pm2Metrics = inventory.appInstances.map(
    (instance) => `http://${instance.privateIp}:9209/metrics`,
  );
  return {
    ...process.env,
    ALLOW_REMOTE_LOAD: 'true',
    REMOTE_APPROVAL_VERIFIED: 'true',
    REMOTE_APPROVAL_MANIFEST: verified.manifestUri,
    REMOTE_APPROVAL_ID: approval.approvalId,
    REMOTE_APPROVAL_VERSION_ID: verified.versionId,
    REMOTE_APPROVAL_CHECKSUM: verified.checksum,
    REMOTE_APPROVAL_ENDS_AT: approval.window.endsAt,
    REMOTE_IMAGE_ROLE: imageRole,
    APP_IMAGE_DIGEST: image.digest,
    BASE_URL: approval.environment.baseUrl,
    TEST_ENVIRONMENT: 'remote-disposable',
    TEST_ENV_ID: approval.environment.id,
    TEST_DATABASE_NAME: approval.environment.databaseName,
    TEST_REDIS_ID: approval.environment.id,
    REDIS_KEY_PREFIX: `k6:${approval.environment.id}:`,
    ALLOW_TEST_DATA_MUTATION: 'true',
    EXPECTED_APP_ID: 'fast_pass',
    EXPECTED_BUILD_SHA: image.gitSha,
    EXPECTED_MIGRATION_ID: approval.environment.expectedMigrationId,
    EXPECTED_DB_TLS_MODE: 'require',
    EXPECTED_REDIS_TLS_MODE: 'require',
    EXPECTED_TRACING_ENABLED: 'false',
    EXPECTED_OTEL_TRACE_SAMPLE_RATIO: '0.1',
    EXPECTED_OTEL_MIN_SPAN_DURATION_MS: '0',
    ARTIFACT_BUCKET: approval.environment.artifactBucket,
    AWS_REGION: approval.environment.region,
    APP_INSTANCE_IDS: approval.environment.appInstanceIds.join(','),
    TARGET_GROUP_ARN: approval.environment.targetGroupArn,
    DATABASE_IDENTIFIER: approval.environment.databaseIdentifier,
    REDIS_CLUSTER_ID: inventory.redis.clusterId,
    WORKER_METRICS_URLS: workerMetrics.join(','),
    PM2_METRICS_URLS: pm2Metrics.join(','),
    AUDIT_REDIS_HOST: inventory.redis.address,
    AUDIT_REDIS_PORT: String(inventory.redis.port),
    WATCHDOG_POLL_INTERVAL_MS: '2000',
    WATCHDOG_CONSECUTIVE_VIOLATIONS: String(approval.abort.consecutiveSamples),
    WATCHDOG_MAX_UNEXPECTED_ERROR_RATE: String(
      approval.abort.unexpectedErrorRate,
    ),
    WATCHDOG_MAX_DATABASE_CONNECTION_RATIO: String(
      approval.abort.databaseConnectionRatio,
    ),
    WATCHDOG_MAX_DATABASE_CPU_PERCENT: String(
      approval.abort.databaseCpuPercent,
    ),
    WATCHDOG_MAX_REDIS_CPU_PERCENT: String(approval.abort.redisCpuPercent),
    WATCHDOG_MAX_REDIS_MEMORY_PERCENT: String(
      approval.abort.redisMemoryPercent,
    ),
    WATCHDOG_MAX_EVENT_LOOP_LAG_MS: String(approval.abort.eventLoopLagMs),
    WATCHDOG_MAX_GENERATOR_CPU_PERCENT: String(
      approval.abort.generatorCpuPercent,
    ),
    WATCHDOG_MAX_QUEUE_DEPTH: String(approval.abort.queueDepth),
    WATCHDOG_MIN_CPU_CREDIT_BALANCE: String(
      approval.abort.minimumCpuCreditBalance,
    ),
    REMOTE_CLEANUP_AUTHORIZED: approval.cleanup.authorized ? 'true' : 'false',
    ALLOW_TEST_DATA_DELETE: approval.cleanup.authorized ? 'true' : 'false',
    RECOVERY_PRODUCER_FENCED: 'false',
    REMOTE_PROFILE_SHA256: hash({
      scenarios: approval.scenarios,
      limits: approval.limits,
      execution: approval.execution,
      abort: approval.abort,
    }),
    REMOTE_INFRASTRUCTURE_SHA256: hash({
      environment: {
        id: approval.environment.id,
        account: approval.environment.awsAccountId,
        region: approval.environment.region,
        targetGroupArn: approval.environment.targetGroupArn,
        appInstanceIds: approval.environment.appInstanceIds,
        databaseIdentifier: approval.environment.databaseIdentifier,
        redisReplicationGroupId: approval.environment.redisReplicationGroupId,
      },
      infrastructure: approval.infrastructure,
    }),
  };
}

function assertRunWithinApproval(run, approval) {
  if (!approval.scenarios.includes(run.scenario)) {
    throw new Error(`${run.runId} scenario is not approved`);
  }
  if (
    run.durationSeconds > approval.limits.maxDurationSeconds ||
    run.approvedRequests > approval.limits.maxRequests ||
    Date.now() + run.durationSeconds * 1000 > Date.parse(approval.window.endsAt)
  ) {
    throw new Error(`${run.runId} no longer fits its approval`);
  }
}

async function uploadIncomplete(env) {
  const metadataPath = path.join(
    repositoryRoot,
    'k6',
    'results',
    env.RUN_ID,
    'metadata.json',
  );
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (metadata.artifactSet === 'INCOMPLETE') {
      await execute(
        'node',
        ['k6/tools/artifact-upload.mjs', 'incomplete'],
        env,
      );
    }
  } catch {
    // No artifact existed long enough to preserve.
  }
}

async function uploadRecoveryRecord(approval, record) {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const checksum = createHash('sha256').update(body).digest('hex');
  const filePath = path.join(
    tmpdir(),
    `fast-pass-recovery-${process.pid}-${Date.now()}.json`,
  );
  try {
    await writeFile(filePath, body, { mode: 0o600, flag: 'wx' });
    await execFileAsync(
      'aws',
      [
        '--region',
        approval.environment.region,
        's3api',
        'put-object',
        '--bucket',
        approval.environment.artifactBucket,
        '--key',
        record.mode === 'execution-intent'
          ? `runs/recovery/${record.runId}/intent.json`
          : `runs/recovery/${record.runId}/${record.executedAt.replaceAll(':', '-')}.json`,
        '--body',
        filePath,
        '--server-side-encryption',
        'AES256',
        '--content-type',
        'application/json',
        '--metadata',
        `sha256=${checksum},retention=permanent`,
        '--no-cli-pager',
      ],
      { timeout: 120_000, maxBuffer: 1024 * 1024 },
    );
  } finally {
    await unlink(filePath).catch(() => undefined);
  }
}

export function assertCleanupDrainProof(audit, runId) {
  if (
    audit?.runId !== runId ||
    audit.drain?.timedOut !== false ||
    audit.queues?.pending !== 0 ||
    audit.queues?.processing !== 0 ||
    Number(audit.counters?.worker_in_flight) !== 0
  ) {
    throw new Error(`${runId} has no verified producer and worker drain proof`);
  }
}

async function verifyCleanupDrainProof(env) {
  const auditPath = path.join(
    repositoryRoot,
    'k6',
    'results',
    env.RUN_ID,
    'consistency-audit.json',
  );
  const audit = JSON.parse(await readFile(auditPath, 'utf8'));
  assertCleanupDrainProof(audit, env.RUN_ID);
}

async function executeRun(run, baseEnv) {
  const env = buildRunEnvironment(baseEnv, run);
  loadConfig(env, { requireExecution: true });
  const runStatus = await execute('bash', ['k6/run.sh'], env);
  if (runStatus === 78) {
    await uploadIncomplete(env);
    throw new Error(
      `${run.runId} monitoring preflight failed before k6 started`,
    );
  }
  try {
    await verifyCleanupDrainProof(env);
  } catch (error) {
    await uploadIncomplete(env);
    throw error;
  }
  const cleanupDryRun = await execute(
    'node',
    ['k6/tools/cleanup.mjs', '--dry-run'],
    env,
  );
  if (cleanupDryRun !== 0) {
    await uploadIncomplete(env);
    throw new Error(`${run.runId} cleanup dry-run failed`);
  }
  const cleanupStatus = await execute(
    'node',
    ['k6/tools/cleanup.mjs', '--execute'],
    env,
  );
  if (cleanupStatus !== 0) {
    await uploadIncomplete(env);
    throw new Error(`${run.runId} exact cleanup failed`);
  }
  for (const args of [
    ['k6/tools/artifact-state.mjs', 'seal-cleanup'],
    ['k6/tools/artifact-state.mjs', 'verify'],
    ['k6/tools/artifact-upload.mjs', 'final'],
  ]) {
    const status = await execute('node', args, env);
    if (status !== 0) throw new Error(`${run.runId} artifact sealing failed`);
  }
  if (runStatus !== 0) {
    throw new Error(`${run.runId} failed after its artifacts were preserved`);
  }
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
    throw new Error('remote agent requires the literal --execute flag');
  }
  requireRuntimeEnvironment();
  const imageRole = process.env.REMOTE_IMAGE_ROLE;
  const approvalArgs = {
    bucket: process.env.REMOTE_APPROVAL_BUCKET,
    approvalId: process.env.REMOTE_APPROVAL_ID,
    versionId: process.env.REMOTE_APPROVAL_VERSION_ID,
    checksum: process.env.REMOTE_APPROVAL_CHECKSUM,
    region: process.env.AWS_REGION || 'ap-northeast-2',
  };
  const initial = await fetchVersionedRemoteApproval({
    ...approvalArgs,
    requireActiveWindow: false,
  });
  let sourceApproval = null;
  if (initial.approval.resume) {
    const source = await fetchVersionedRemoteApproval({
      bucket: process.env.REMOTE_APPROVAL_BUCKET,
      approvalId: initial.approval.resume.sourceApprovalId,
      versionId: initial.approval.resume.sourceVersionId,
      checksum: initial.approval.resume.sourceChecksum,
      region: process.env.AWS_REGION || 'ap-northeast-2',
      requireActiveWindow: false,
    });
    assertResumeScope(initial.approval, source.approval, {
      approvalId: initial.approval.resume.sourceApprovalId,
      versionId: initial.approval.resume.sourceVersionId,
      checksum: initial.approval.resume.sourceChecksum,
    });
    if (
      process.env.REMOTE_EXECUTION_TIMESTAMP !==
      initial.approval.resume.executionTimestamp
    ) {
      throw new Error('resume execution timestamp does not match approval');
    }
    sourceApproval = source.approval;
  }
  const matrixStartedAt = new Date();
  const matrix = buildRemoteExecutionMatrix(
    initial.approval,
    matrixStartedAt,
    process.env.REMOTE_EXECUTION_TIMESTAMP,
    { validateEnvelopes: false },
  ).filter((run) => run.imageRole === imageRole);
  if (matrix.length === 0)
    throw new Error('approved execution matrix is empty');
  const remainingMatrix = await selectRemainingRemoteRuns({
    matrix,
    approval: initial.approval,
    currentIdentity: {
      approvalId: initial.approval.approvalId,
      versionId: initial.versionId,
      checksum: initial.checksum,
      executionTimestamp: process.env.REMOTE_EXECUTION_TIMESTAMP,
    },
    sourceApproval,
  });
  validateExecutionEnvelopes(
    initial.approval,
    remainingMatrix,
    matrixStartedAt,
  );
  if (remainingMatrix.length === 0) {
    process.stdout.write(`remote image role already completed: ${imageRole}\n`);
    return;
  }
  await verifyLocalGates(repositoryRoot, initial.approval);
  const initialInventory = await inspectRemoteInfrastructure(
    initial.approval,
    initial.approval.images[imageRole],
  );
  await verifyRemoteStorage(initial.approval);
  assertGeneratorLifetimeHeadroom(
    initial.approval,
    remainingMatrix,
    initialInventory.loadGenerator,
    matrixStartedAt,
  );

  for (const run of remainingMatrix) {
    const verified = await fetchVersionedRemoteApproval(approvalArgs);
    const approval = verified.approval;
    assertRunWithinApproval(run, approval);
    await verifyLocalGates(repositoryRoot, approval);
    const inventory = await inspectRemoteInfrastructure(
      approval,
      approval.images[imageRole],
    );
    await verifyRemoteStorage(approval);
    const env = commonRunEnvironment(approval, verified, inventory, imageRole);
    let recovered = false;
    if (
      approval.resume &&
      (await remoteRunHasEvidence(run, approval, {
        approvalId: approval.approvalId,
        versionId: verified.versionId,
        checksum: verified.checksum,
        executionTimestamp: process.env.REMOTE_EXECUTION_TIMESTAMP,
      }))
    ) {
      const sameGenerator =
        sourceApproval?.environment?.loadGeneratorInstanceId ===
        approval.environment.loadGeneratorInstanceId;
      const hostFence = sameGenerator && hasExclusiveHostFence();
      const sourceRetired =
        !sameGenerator &&
        (await verifySourceGeneratorRetired(approval, sourceApproval));
      assertRecoveryProducerFence({
        sameGenerator,
        hostFence,
        sourceRetired,
      });
      env.RECOVERY_PRODUCER_FENCED = 'true';
      const recovery = await recoverRangeOwnedData(
        loadConfig(
          { ...env, ...run.env, RUN_ID: run.runId, SCENARIO: run.scenario },
          { requireExecution: true },
        ),
        env,
      );
      await uploadRecoveryRecord(approval, recovery);
      process.stdout.write(`resume exact cleanup verified: ${run.runId}\n`);
      recovered = true;
    }
    if (recovered) {
      await verifyPostRecoveryReadiness(buildRunEnvironment(env, run));
    }
    await uploadRecoveryRecord(approval, {
      schemaVersion: 1,
      runId: run.runId,
      testEnvId: approval.environment.id,
      scenario: run.scenario,
      mode: 'execution-intent',
      executedAt: new Date().toISOString(),
      fixture: {
        kind: 'deterministic-v1',
        userCount: Number(run.env.USER_COUNT),
        seatCount: Number(run.env.SEAT_COUNT),
      },
      remoteApproval: {
        approvalId: approval.approvalId,
        versionId: verified.versionId,
        checksum: verified.checksum,
        executionTimestamp: process.env.REMOTE_EXECUTION_TIMESTAMP,
      },
      immutableImages: {
        role: imageRole,
        applicationDigest: approval.images[imageRole].digest,
        runnerDigest: approval.images.runner.digest,
      },
    });
    await executeRun(run, env);
  }
  process.stdout.write(`remote image role completed: ${imageRole}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`remote agent rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
