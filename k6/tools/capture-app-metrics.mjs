#!/usr/bin/env node

import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.js';
import { parsePrometheusSnapshot } from '../lib/prometheus.js';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');
const MAX_METRICS_BYTES = 2 * 1024 * 1024;

async function atomicWrite(filePath, value) {
  const temporary = `${filePath}.write-${process.pid}`;
  await writeFile(temporary, value, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

async function main() {
  const config = loadConfig(process.env, { requireExecution: true });
  if (!config.isLocal) throw new Error('metrics target is not loopback');
  const response = await fetch(`${config.baseUrl}/metrics`, {
    headers: { Accept: 'text/plain' },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (response.status !== 200) throw new Error('metrics endpoint rejected');
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_METRICS_BYTES) {
    throw new Error('metrics response is too large');
  }
  const snapshot = parsePrometheusSnapshot(raw);
  if (snapshot.series.length === 0) {
    throw new Error('metrics endpoint returned no required series');
  }
  const destination = path.join(
    repositoryRoot,
    config.resultDir,
    '.app-metrics-baseline.json.tmp',
  );
  await atomicWrite(destination, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write('application metrics baseline captured\n');
}

main().catch((error) => {
  process.stderr.write(`metrics capture rejected: ${error.message}\n`);
  process.exitCode = 1;
});
