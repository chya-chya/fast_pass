#!/usr/bin/env node

import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, toPublicConfig } from '../lib/config.js';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');
const resultsRoot = path.join(repositoryRoot, 'k6', 'results');

async function validateResultPath(config) {
  const rootStat = await lstat(resultsRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('results root must be a real directory');
  }

  const canonicalRoot = await realpath(resultsRoot);
  const candidate = path.resolve(resultsRoot, config.runId);
  if (path.dirname(candidate) !== canonicalRoot) {
    throw new Error('result path must remain directly below k6/results');
  }

  try {
    const candidateStat = await lstat(candidate);
    if (candidateStat.isSymbolicLink()) {
      throw new Error('result path must not be a symbolic link');
    }
    throw new Error('result directory already exists');
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
}

async function main() {
  if (
    process.argv.length !== 3 ||
    !['--validate', '--dry-run', '--script'].includes(process.argv[2])
  ) {
    throw new Error('usage: config-cli.mjs --validate|--dry-run|--script');
  }

  const config = loadConfig(process.env, { requireExecution: true });
  await validateResultPath(config);
  if (process.argv[2] === '--dry-run') {
    process.stdout.write(
      `${JSON.stringify(toPublicConfig(config), null, 2)}\n`,
    );
  }
  if (process.argv[2] === '--script') {
    process.stdout.write(`${config.scriptPath}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`configuration rejected: ${error.message}\n`);
  process.exitCode = 1;
});
