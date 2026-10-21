import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { awsJson } from './remote-inventory.mjs';

const execFileAsync = promisify(execFile);
const FINAL_FILES = Object.freeze([
  'metadata.json',
  'fixture-manifest.json',
  'summary.json',
  'consistency-audit.json',
  'server-metrics.json',
  'report.md',
  'checksums.sha256',
  'cleanup.json',
]);
const CHECKSUM_FILES = Object.freeze(
  FINAL_FILES.filter((name) => name !== 'checksums.sha256'),
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function validateRemoteChecksumSet(objects) {
  const lines = objects['checksums.sha256']?.trim().split('\n') || [];
  const entries = lines.map((line) =>
    /^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/.exec(line),
  );
  if (
    entries.some((entry) => !entry) ||
    entries.length !== CHECKSUM_FILES.length
  ) {
    throw new Error('remote checksum manifest schema is invalid');
  }
  const remaining = new Set(CHECKSUM_FILES);
  for (const [, expected, name] of entries) {
    if (!remaining.delete(name) || typeof objects[name] !== 'string') {
      throw new Error('remote checksum manifest contains an unexpected file');
    }
    if (sha256(objects[name]) !== expected) {
      throw new Error(`remote artifact generation mismatch for ${name}`);
    }
  }
  if (remaining.size !== 0) {
    throw new Error('remote checksum manifest is incomplete');
  }
}

function resumeScope(approval) {
  const { loadGeneratorInstanceId: _generator, ...environment } =
    approval.environment;
  return {
    approvalId: approval.approvalId,
    approvedBy: approval.approvedBy,
    responsibility: approval.responsibility,
    environment,
    mode: approval.mode,
    candidate: approval.images.candidate,
    runner: approval.images.runner,
    infrastructure: approval.infrastructure,
    limits: approval.limits,
    execution: approval.execution,
    abort: approval.abort,
    cleanup: approval.cleanup,
    retention: approval.retention,
    gates: approval.gates,
    scenarios: approval.scenarios,
  };
}

export function assertResumeScope(current, source, sourceIdentity) {
  if (!current.resume) throw new Error('resume approval lineage is missing');
  if (
    current.resume.sourceApprovalId !== sourceIdentity.approvalId ||
    current.resume.sourceVersionId !== sourceIdentity.versionId ||
    current.resume.sourceChecksum !== sourceIdentity.checksum
  ) {
    throw new Error('resume approval lineage does not match its source');
  }
  if (canonical(resumeScope(current)) !== canonical(resumeScope(source))) {
    throw new Error('resume approval expands or changes the approved scope');
  }
}

function isMissing(error) {
  return /(?:404|Not Found|NoSuchKey)/i.test(error?.message || '');
}

async function readVerifiedObject(region, bucket, key) {
  let head;
  try {
    head = await awsJson(region, [
      's3api',
      'head-object',
      '--bucket',
      bucket,
      '--key',
      key,
    ]);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const expected = head.Metadata?.sha256 || '';
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error(`${key} is missing checksum metadata`);
  }
  const { stdout } = await execFileAsync(
    'aws',
    [
      '--region',
      region,
      's3',
      'cp',
      `s3://${bucket}/${key}`,
      '-',
      '--no-progress',
      '--no-cli-pager',
    ],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (sha256(stdout) !== expected) {
    throw new Error(`${key} checksum does not match its metadata`);
  }
  return stdout;
}

export function validateSealedRunArtifacts({
  metadata,
  cleanup,
  run,
  approval,
  currentIdentity,
  sourceApproval,
}) {
  if (
    metadata.runId !== run.runId ||
    metadata.scenario !== run.scenario ||
    metadata.execution !== 'COMPLETED' ||
    metadata.artifactSet !== 'FINALIZED' ||
    metadata.preflight !== 'VERIFIED' ||
    metadata.audit?.pass !== true ||
    metadata.cleanup?.status !== 'VERIFIED'
  ) {
    throw new Error(`${run.runId} is not a completed, verified run`);
  }
  const lineage = metadata.remoteApproval || {};
  const currentLineage =
    lineage.approvalId === currentIdentity.approvalId &&
    lineage.versionId === currentIdentity.versionId &&
    lineage.checksum === currentIdentity.checksum;
  const sourceLineage =
    approval.resume &&
    sourceApproval &&
    lineage.approvalId === approval.resume.sourceApprovalId &&
    lineage.versionId === approval.resume.sourceVersionId &&
    lineage.checksum === approval.resume.sourceChecksum &&
    lineage.executionTimestamp === approval.resume.executionTimestamp;
  if (!currentLineage && !sourceLineage) {
    throw new Error(`${run.runId} approval lineage is not reusable`);
  }
  const expectedRunner = currentLineage
    ? approval.images.runner.digest
    : sourceApproval.images.runner.digest;
  if (
    metadata.immutableImages?.role !== run.imageRole ||
    metadata.immutableImages?.applicationGitSha !==
      approval.images[run.imageRole].gitSha ||
    metadata.immutableImages?.applicationDigest !==
      approval.images[run.imageRole].digest ||
    metadata.immutableImages?.runnerDigest !== expectedRunner
  ) {
    throw new Error(`${run.runId} immutable image identity is not reusable`);
  }
  if (
    cleanup.runId !== run.runId ||
    cleanup.mode !== 'executed' ||
    cleanup.verification?.runOwnedRowsRemaining !== 0 ||
    cleanup.verification?.foreignRunDataPreserved !== true
  ) {
    throw new Error(`${run.runId} cleanup proof is not reusable`);
  }
  return true;
}

export async function inspectSealedRemoteRun({
  run,
  approval,
  currentIdentity,
  sourceApproval,
}) {
  const region = approval.environment.region;
  const bucket = approval.environment.artifactBucket;
  const prefix = `runs/summary/${run.runId}`;
  const metadataRaw = await readVerifiedObject(
    region,
    bucket,
    `${prefix}/metadata.json`,
  );
  if (metadataRaw === null) return false;
  const metadata = JSON.parse(metadataRaw);
  if (metadata.artifactSet === 'INCOMPLETE') return false;
  const objects = {};
  for (const name of FINAL_FILES) {
    const raw =
      name === 'metadata.json'
        ? metadataRaw
        : await readVerifiedObject(region, bucket, `${prefix}/${name}`);
    if (raw === null) {
      return false;
    }
    objects[name] = raw;
  }
  try {
    validateRemoteChecksumSet(objects);
  } catch (error) {
    if (
      /remote checksum manifest|artifact generation mismatch/.test(
        error.message,
      )
    ) {
      return false;
    }
    throw error;
  }
  if (
    metadata.execution !== 'COMPLETED' ||
    metadata.preflight !== 'VERIFIED' ||
    metadata.audit?.pass !== true ||
    metadata.cleanup?.status !== 'VERIFIED'
  ) {
    return false;
  }
  validateSealedRunArtifacts({
    metadata,
    cleanup: JSON.parse(objects['cleanup.json']),
    run,
    approval,
    currentIdentity,
    sourceApproval,
  });
  return true;
}

export async function selectRemainingRemoteRuns({
  matrix,
  approval,
  currentIdentity,
  sourceApproval,
  inspect = inspectSealedRemoteRun,
}) {
  if (!approval.resume) return [...matrix];
  const remaining = [];
  for (const run of matrix) {
    const sealed = await inspect({
      run,
      approval,
      currentIdentity,
      sourceApproval,
    });
    if (!sealed) remaining.push(run);
  }
  return remaining;
}

export function validateRecoveryIntent(intent, run, approval, currentIdentity) {
  const lineage = intent.remoteApproval || {};
  const approvalMatches =
    (lineage.approvalId === currentIdentity.approvalId &&
      lineage.versionId === currentIdentity.versionId &&
      lineage.checksum === currentIdentity.checksum &&
      lineage.executionTimestamp === currentIdentity.executionTimestamp) ||
    (approval.resume &&
      lineage.approvalId === approval.resume.sourceApprovalId &&
      lineage.versionId === approval.resume.sourceVersionId &&
      lineage.checksum === approval.resume.sourceChecksum &&
      lineage.executionTimestamp === approval.resume.executionTimestamp);
  if (
    intent.runId !== run.runId ||
    intent.testEnvId !== approval.environment.id ||
    intent.scenario !== run.scenario ||
    intent.fixture?.kind !== 'deterministic-v1' ||
    intent.immutableImages?.role !== run.imageRole ||
    intent.immutableImages?.applicationDigest !==
      approval.images[run.imageRole].digest ||
    !approvalMatches
  ) {
    throw new Error(`${run.runId} recovery intent is not reusable`);
  }
  return true;
}

export function assertNoLegacyRecoveryEvidence(hasLegacyEvidence, runId) {
  if (hasLegacyEvidence) {
    throw new Error(
      `${runId} has legacy evidence without a deterministic recovery intent; manual intervention is required`,
    );
  }
}

export async function remoteRunHasEvidence(run, approval, currentIdentity) {
  const region = approval.environment.region;
  const bucket = approval.environment.artifactBucket;
  const intentKey = `runs/recovery/${run.runId}/intent.json`;
  const intentRaw = await readVerifiedObject(region, bucket, intentKey);
  if (intentRaw !== null) {
    const intent = JSON.parse(intentRaw);
    validateRecoveryIntent(intent, run, approval, currentIdentity);
    return true;
  }
  for (const key of [
    `runs/summary/${run.runId}/metadata.json`,
    `runs/raw/${run.runId}/server-timeseries.ndjson.gz`,
  ]) {
    try {
      await awsJson(region, [
        's3api',
        'head-object',
        '--bucket',
        bucket,
        '--key',
        key,
      ]);
      assertNoLegacyRecoveryEvidence(true, run.runId);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  assertNoLegacyRecoveryEvidence(false, run.runId);
  return false;
}
