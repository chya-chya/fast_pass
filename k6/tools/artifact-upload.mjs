#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { loadConfig } from '../lib/config.js';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const FINAL_FILES = Object.freeze([
  'fixture-manifest.json',
  'summary.json',
  'consistency-audit.json',
  'server-metrics.json',
  'report.md',
  'cleanup.json',
  'checksums.sha256',
  // metadata.json is the commit marker. It must be published only after every
  // object referenced by checksums.sha256 is durable.
  'metadata.json',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function atomicWrite(filePath, value) {
  const temporary = `${filePath}.write-${process.pid}`;
  await writeFile(temporary, value, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

function artifactBucket() {
  const bucket = process.env.ARTIFACT_BUCKET || '';
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('ARTIFACT_BUCKET is invalid');
  }
  return bucket;
}

async function putObject(bucket, key, body, contentType, metadata) {
  const region = process.env.AWS_REGION || 'ap-northeast-2';
  const result = await execFileAsync(
    'aws',
    [
      '--region',
      region,
      's3api',
      'put-object',
      '--bucket',
      bucket,
      '--key',
      key,
      '--body',
      body,
      '--server-side-encryption',
      'AES256',
      '--content-type',
      contentType,
      '--metadata',
      metadata,
      '--output',
      'json',
      '--no-cli-pager',
    ],
    { timeout: 120_000, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}

async function uploadRaw(config, bucket, resultDirectory) {
  const sourcePath = path.join(
    resultDirectory,
    '.server-timeseries.ndjson.tmp',
  );
  const compressedPath = path.join(
    resultDirectory,
    '.server-timeseries.ndjson.gz.tmp',
  );
  const raw = await readFile(sourcePath);
  const compressed = gzipSync(raw, { level: 9, mtime: 0 });
  await writeFile(compressedPath, compressed, { mode: 0o600, flag: 'wx' });
  const checksum = sha256(compressed);
  const key = `runs/raw/${config.runId}/server-timeseries.ndjson.gz`;
  const uploaded = await putObject(
    bucket,
    key,
    compressedPath,
    'application/x-ndjson',
    `sha256=${checksum},retention-days=90`,
  );
  const metricsPath = path.join(resultDirectory, '.server-metrics.json.tmp');
  const metrics = JSON.parse(await readFile(metricsPath, 'utf8'));
  metrics.rawTimeseries = {
    status: 'available',
    uri: `s3://${bucket}/${key}`,
    versionId: uploaded.VersionId || null,
    sha256: checksum,
    compressedBytes: compressed.byteLength,
    startedAt: metrics.window.startedAt,
    finishedAt: metrics.window.finishedAt || metrics.window.endedAt,
    timezone: 'UTC',
    retentionDays: 90,
  };
  await atomicWrite(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
}

async function uploadFinal(config, bucket, resultDirectory) {
  for (const name of FINAL_FILES) {
    const filePath = path.join(resultDirectory, name);
    const contents = await readFile(filePath);
    const contentType = name.endsWith('.json')
      ? 'application/json'
      : name.endsWith('.md')
        ? 'text/markdown'
        : 'text/plain';
    await putObject(
      bucket,
      `runs/summary/${config.runId}/${name}`,
      filePath,
      contentType,
      `sha256=${sha256(contents)},retention=permanent`,
    );
  }
}

async function uploadIncomplete(config, bucket, resultDirectory) {
  const filePath = path.join(resultDirectory, 'metadata.json');
  const contents = await readFile(filePath);
  const metadata = JSON.parse(contents);
  if (
    metadata.runId !== config.runId ||
    metadata.artifactSet !== 'INCOMPLETE' ||
    !['FAILED', 'ABORTED'].includes(metadata.execution)
  ) {
    throw new Error('incomplete artifact metadata is invalid');
  }
  await putObject(
    bucket,
    `runs/summary/${config.runId}/metadata.json`,
    filePath,
    'application/json',
    `sha256=${sha256(contents)},retention=permanent,incomplete=true`,
  );
}

async function main() {
  const mode = process.argv[2];
  if (
    !['raw', 'final', 'incomplete'].includes(mode) ||
    process.argv.length !== 3
  ) {
    throw new Error('usage: artifact-upload.mjs raw|final|incomplete');
  }
  const config = loadConfig(process.env, { requireExecution: true });
  if (config.isLocal || process.env.REMOTE_APPROVAL_VERIFIED !== 'true') {
    throw new Error('artifact upload is remote-only');
  }
  const resultDirectory = path.join(repositoryRoot, config.resultDir);
  const bucket = artifactBucket();
  if (mode === 'raw') await uploadRaw(config, bucket, resultDirectory);
  else if (mode === 'final') await uploadFinal(config, bucket, resultDirectory);
  else await uploadIncomplete(config, bucket, resultDirectory);
  process.stdout.write(`artifact ${mode} upload completed\n`);
}

main().catch((error) => {
  process.stderr.write(`artifact upload rejected: ${error.message}\n`);
  process.exitCode = 1;
});
