#!/usr/bin/env node

import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../lib/config.js';
import { collectApplicationSnapshot } from './metrics-source.mjs';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');

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
  const snapshot = await collectApplicationSnapshot(config);
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
