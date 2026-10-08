#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, toPublicConfig } from '../lib/config.js';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');
const resultsRoot = path.join(repositoryRoot, 'k6', 'results');
const EXECUTION_STATES = new Set(['COMPLETED', 'FAILED', 'ABORTED']);
const FAILURE_CODES = new Set([
  'NONE',
  'PREFLIGHT_REJECTED',
  'K6_FAILED',
  'INTERRUPTED',
  'ARTIFACT_VALIDATION_FAILED',
  'AUDIT_FAILED',
  'RUNNER_FAILED',
]);
const SUMMARY_METRICS = new Set([
  'checks',
  'http_req_duration',
  'http_req_failed',
  'iterations',
  'vus_max',
  'accepted',
  'expected_conflict',
  'unexpected_error',
  'timeout',
  'request_start_offset_ms',
  'rebooking_first_accepted',
  'rebooking_second_accepted',
]);
const SENSITIVE_KEY =
  /(authorization|password|secret|access.?token|refresh.?token|database.?url|redis.?url|preflight.?token)/i;
const SENSITIVE_TEXT =
  /(bearer\s+[A-Za-z0-9._~+\/-]+=*|postgres(?:ql)?:\/\/[^\s"']+|redis(?:s)?:\/\/[^\s"']+)/i;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function atomicWrite(filePath, contents) {
  const tempPath = `${filePath}.write-${process.pid}`;
  await writeFile(tempPath, contents, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await rename(tempPath, filePath);
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : 'unavailable';
}

function assertNoSecrets(value, pathName = 'artifact') {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoSecrets(item, `${pathName}[${index}]`),
    );
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key))
        throw new Error(`${pathName} contains a forbidden field`);
      assertNoSecrets(child, `${pathName}.${key}`);
    }
    return;
  }
  if (typeof value === 'string' && SENSITIVE_TEXT.test(value)) {
    throw new Error(`${pathName} contains sensitive text`);
  }
}

async function getPaths(config) {
  const resultDirectory = path.join(resultsRoot, config.runId);
  const root = await lstat(resultsRoot);
  const result = await lstat(resultDirectory);
  if (
    !root.isDirectory() ||
    root.isSymbolicLink() ||
    !result.isDirectory() ||
    result.isSymbolicLink() ||
    path.dirname(resultDirectory) !== resultsRoot
  ) {
    throw new Error('artifact path is unsafe');
  }
  return {
    resultDirectory,
    metadata: path.join(resultDirectory, 'metadata.json'),
    summaryTemp: path.join(resultDirectory, '.summary.json.tmp'),
    summary: path.join(resultDirectory, 'summary.json'),
    fixtureTemp: path.join(resultDirectory, '.fixture-manifest.json.tmp'),
    fixture: path.join(resultDirectory, 'fixture-manifest.json'),
    auditTemp: path.join(resultDirectory, '.consistency-audit.json.tmp'),
    audit: path.join(resultDirectory, 'consistency-audit.json'),
    metricsTemp: path.join(resultDirectory, '.server-metrics.json.tmp'),
    metrics: path.join(resultDirectory, 'server-metrics.json'),
    metricsBaselineTemp: path.join(
      resultDirectory,
      '.app-metrics-baseline.json.tmp',
    ),
    reportTemp: path.join(resultDirectory, '.report.md.tmp'),
    report: path.join(resultDirectory, 'report.md'),
    checksums: path.join(resultDirectory, 'checksums.sha256'),
  };
}

function validateSummary(summary, config) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw new Error('summary must be an object');
  }
  if (
    summary.schemaVersion !== 1 ||
    summary.runId !== config.runId ||
    summary.scenario !== config.scenario ||
    typeof summary.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(summary.generatedAt)) ||
    typeof summary.thresholdPassed !== 'boolean' ||
    !Array.isArray(summary.thresholdFailures) ||
    !summary.metrics ||
    typeof summary.metrics !== 'object' ||
    Array.isArray(summary.metrics)
  ) {
    throw new Error('summary schema is invalid');
  }
  if (
    summary.thresholdFailures.some(
      (failure) =>
        !failure ||
        typeof failure !== 'object' ||
        typeof failure.metric !== 'string' ||
        typeof failure.threshold !== 'string',
    ) ||
    Object.keys(summary.metrics).some((name) => !SUMMARY_METRICS.has(name))
  ) {
    throw new Error('summary schema is invalid');
  }
  assertNoSecrets(summary, 'summary');
}

function validateFixture(fixture, config) {
  if (
    !fixture ||
    fixture.schemaVersion !== 1 ||
    fixture.runId !== config.runId ||
    fixture.testEnvId !== config.testEnvId ||
    !Array.isArray(fixture.userIds) ||
    !Array.isArray(fixture.eventIds) ||
    !Array.isArray(fixture.performanceIds) ||
    !Array.isArray(fixture.seatIds) ||
    !Array.isArray(fixture.requestIds) ||
    !Array.isArray(fixture.reservationIds) ||
    !fixture.counts ||
    typeof fixture.counts !== 'object'
  ) {
    throw new Error('fixture manifest schema is invalid');
  }
  assertNoSecrets(fixture, 'fixture manifest');
}

function validateAudit(audit, config) {
  if (
    !audit ||
    audit.schemaVersion !== 1 ||
    audit.runId !== config.runId ||
    audit.testEnvId !== config.testEnvId ||
    !audit.drain ||
    !audit.queues ||
    !audit.counters ||
    !audit.database ||
    !audit.ids ||
    !Array.isArray(audit.ids.acceptedReservationIds) ||
    !Array.isArray(audit.ids.persistedReservationIds) ||
    !audit.consistency ||
    typeof audit.consistency.pass !== 'boolean' ||
    !Array.isArray(audit.consistency.reasons)
  ) {
    throw new Error('consistency audit schema is invalid');
  }
  if (
    config.scenario !== 'smoke' &&
    (!audit.requestAudit ||
      typeof audit.requestAudit.expectedCount !== 'number' ||
      typeof audit.requestAudit.actualCount !== 'number' ||
      !audit.requestAudit.expectedRequestsPerSeat ||
      !audit.requestAudit.actualRequestsPerSeat)
  ) {
    throw new Error('consistency request audit schema is invalid');
  }
  if (
    config.scenario === 'rebooking' &&
    (!audit.rebooking ||
      !audit.rebooking.firstReservationId ||
      !audit.rebooking.secondReservationId ||
      typeof audit.rebooking.activeCount !== 'number')
  ) {
    throw new Error('rebooking audit schema is invalid');
  }
  assertNoSecrets(audit, 'consistency audit');
}

function validateServerMetrics(metrics, config) {
  if (
    !metrics ||
    ![1, 2].includes(metrics.schemaVersion) ||
    metrics.runId !== config.runId ||
    !metrics.window ||
    !metrics.app ||
    !metrics.database ||
    !metrics.redis
  ) {
    throw new Error('server metrics schema is invalid');
  }
  for (const component of [metrics.app, metrics.database, metrics.redis]) {
    if (!['available', 'unavailable'].includes(component.status)) {
      throw new Error('server metrics component status is invalid');
    }
    if (component.status === 'unavailable' && !component.reason) {
      throw new Error('unavailable server metrics require a reason');
    }
  }
  if (
    metrics.schemaVersion === 2 &&
    (metrics.window.timezone !== 'UTC' ||
      typeof metrics.app.valid !== 'boolean' ||
      !Array.isArray(metrics.app.missingMetrics) ||
      !metrics.pm2)
  ) {
    throw new Error('server metrics observability schema is invalid');
  }
  assertNoSecrets(metrics, 'server metrics');
}

function validateReport(report, config) {
  if (
    typeof report !== 'string' ||
    !report.startsWith(`# k6 Run ${config.runId}\n`) ||
    !report.includes('## 정합성 결과') ||
    !report.includes('## 한계') ||
    !report.includes('## 다음 결정')
  ) {
    throw new Error('report schema is invalid');
  }
  assertNoSecrets(report, 'report');
}

async function readMetadata(metadataPath, config) {
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.runId !== config.runId || metadata.schemaVersion !== 1) {
    throw new Error('metadata identity is invalid');
  }
  return metadata;
}

export async function initializeArtifacts(config) {
  const paths = await getPaths(config);
  const script = await readFile(path.join(repositoryRoot, config.scriptPath));
  const gitSha = commandOutput('git', ['rev-parse', 'HEAD']);
  const gitStatus = commandOutput('git', ['status', '--porcelain']);
  const metadata = {
    schemaVersion: 1,
    runId: config.runId,
    scenario: config.scenario,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    execution: 'RUNNING',
    artifactSet: 'OPEN',
    preflight: 'PENDING',
    preflightVerifiedAt: null,
    statusReason: null,
    source: {
      gitSha,
      gitDirty: gitStatus === 'unavailable' ? null : gitStatus.length > 0,
      scriptSha256: sha256(script),
    },
    runtime: {
      node: process.version,
      k6: commandOutput('k6', ['version']),
    },
    parameters: toPublicConfig(config),
  };
  assertNoSecrets(metadata, 'metadata');
  await atomicWrite(paths.metadata, `${JSON.stringify(metadata, null, 2)}\n`);
}

export async function markPreflightVerified(config) {
  const paths = await getPaths(config);
  const metadata = await readMetadata(paths.metadata, config);
  if (metadata.execution !== 'RUNNING' || metadata.artifactSet !== 'OPEN') {
    throw new Error('artifact set is not open');
  }
  const next = {
    ...metadata,
    preflight: 'VERIFIED',
    preflightVerifiedAt: new Date().toISOString(),
  };
  assertNoSecrets(next, 'metadata');
  await atomicWrite(paths.metadata, `${JSON.stringify(next, null, 2)}\n`);
}

export async function markIncomplete(config, execution, statusReason) {
  if (!EXECUTION_STATES.has(execution) || !FAILURE_CODES.has(statusReason)) {
    throw new Error('invalid artifact state transition');
  }
  const paths = await getPaths(config);
  for (const tempPath of [
    paths.summaryTemp,
    paths.fixtureTemp,
    paths.auditTemp,
    paths.metricsTemp,
    paths.metricsBaselineTemp,
    paths.reportTemp,
  ]) {
    try {
      await unlink(tempPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  const metadata = await readMetadata(paths.metadata, config);
  if (
    metadata.artifactSet === 'FINALIZED' &&
    statusReason !== 'ARTIFACT_VALIDATION_FAILED'
  )
    return;
  const next = {
    ...metadata,
    finishedAt: new Date().toISOString(),
    execution,
    artifactSet: 'INCOMPLETE',
    statusReason,
  };
  assertNoSecrets(next, 'metadata');
  await atomicWrite(paths.metadata, `${JSON.stringify(next, null, 2)}\n`);
}

export async function finalizeArtifacts(config, execution, statusReason) {
  if (!EXECUTION_STATES.has(execution) || !FAILURE_CODES.has(statusReason)) {
    throw new Error('invalid artifact state transition');
  }
  const paths = await getPaths(config);
  const current = await readMetadata(paths.metadata, config);
  if (current.execution !== 'RUNNING' || current.artifactSet !== 'OPEN') {
    throw new Error('artifact set is not open');
  }
  if (current.preflight !== 'VERIFIED') {
    throw new Error('preflight was not verified');
  }

  const summaryText = await readFile(paths.summaryTemp, 'utf8');
  const summary = JSON.parse(summaryText);
  validateSummary(summary, config);
  const fixture = JSON.parse(await readFile(paths.fixtureTemp, 'utf8'));
  validateFixture(fixture, config);
  const audit = JSON.parse(await readFile(paths.auditTemp, 'utf8'));
  validateAudit(audit, config);
  const metrics = JSON.parse(await readFile(paths.metricsTemp, 'utf8'));
  validateServerMetrics(metrics, config);
  const report = await readFile(paths.reportTemp, 'utf8');
  validateReport(report, config);
  const normalizedSummary = `${JSON.stringify(summary, null, 2)}\n`;
  const normalizedFixture = `${JSON.stringify(fixture, null, 2)}\n`;
  const normalizedAudit = `${JSON.stringify(audit, null, 2)}\n`;
  const normalizedMetrics = `${JSON.stringify(metrics, null, 2)}\n`;
  const finalMetadata = {
    ...current,
    finishedAt: new Date().toISOString(),
    execution,
    artifactSet: 'FINALIZED',
    statusReason,
    audit: {
      pass: audit.consistency.pass,
      reasons: audit.consistency.reasons,
    },
    artifacts: [
      'metadata.json',
      'fixture-manifest.json',
      'summary.json',
      'consistency-audit.json',
      'server-metrics.json',
      'report.md',
    ],
  };
  assertNoSecrets(finalMetadata, 'metadata');
  const metadataText = `${JSON.stringify(finalMetadata, null, 2)}\n`;
  const checksums = [
    `${sha256(metadataText)}  metadata.json`,
    `${sha256(normalizedFixture)}  fixture-manifest.json`,
    `${sha256(normalizedSummary)}  summary.json`,
    `${sha256(normalizedAudit)}  consistency-audit.json`,
    `${sha256(normalizedMetrics)}  server-metrics.json`,
    `${sha256(report)}  report.md`,
    '',
  ].join('\n');

  await atomicWrite(paths.fixture, normalizedFixture);
  await atomicWrite(paths.summary, normalizedSummary);
  await atomicWrite(paths.audit, normalizedAudit);
  await atomicWrite(paths.metrics, normalizedMetrics);
  await atomicWrite(paths.report, report);
  await atomicWrite(paths.checksums, checksums);
  await atomicWrite(paths.metadata, metadataText);
  await Promise.all([
    unlink(paths.summaryTemp),
    unlink(paths.fixtureTemp),
    unlink(paths.auditTemp),
    unlink(paths.metricsTemp),
    unlink(paths.metricsBaselineTemp).catch((error) => {
      if (!error || error.code !== 'ENOENT') throw error;
    }),
    unlink(paths.reportTemp),
  ]);
}

export async function verifyArtifacts(config) {
  const paths = await getPaths(config);
  const checksumText = await readFile(paths.checksums, 'utf8');
  const expectedFiles = new Set([
    'metadata.json',
    'fixture-manifest.json',
    'summary.json',
    'consistency-audit.json',
    'server-metrics.json',
    'report.md',
  ]);
  const entries = checksumText
    .trim()
    .split('\n')
    .map((line) => /^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/.exec(line));
  if (
    entries.some((entry) => !entry) ||
    entries.length !== expectedFiles.size
  ) {
    throw new Error('checksum manifest schema is invalid');
  }
  for (const entry of entries) {
    const [, expectedHash, fileName] = entry;
    if (!expectedFiles.delete(fileName)) {
      throw new Error('checksum manifest contains an unexpected file');
    }
    const contents = await readFile(path.join(paths.resultDirectory, fileName));
    if (sha256(contents) !== expectedHash) {
      throw new Error(`checksum mismatch for ${fileName}`);
    }
  }
  if (expectedFiles.size !== 0)
    throw new Error('checksum manifest is incomplete');
}

async function main() {
  const [command, execution, statusReason] = process.argv.slice(2);
  if (
    !['init', 'preflight', 'finalize', 'incomplete', 'verify'].includes(command)
  ) {
    throw new Error(
      'usage: artifact-state.mjs init|preflight|finalize|incomplete|verify',
    );
  }
  const config = loadConfig(process.env, { requireExecution: true });
  if (command === 'init') return initializeArtifacts(config);
  if (command === 'preflight') return markPreflightVerified(config);
  if (command === 'verify') return verifyArtifacts(config);
  if (command === 'finalize')
    return finalizeArtifacts(config, execution, statusReason);
  return markIncomplete(config, execution, statusReason);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`artifact operation rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
