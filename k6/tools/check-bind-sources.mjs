#!/usr/bin/env node

import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');
const requiredSources = [
  'Dockerfile.dev',
  'prometheus.yml',
  'ecosystem.config.js',
  'nginx/nginx.conf',
  'prometheus.yml.template',
  'monitoring-entrypoint.sh',
];

async function main() {
  for (const relativePath of requiredSources) {
    const stat = await lstat(path.join(repositoryRoot, relativePath));
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${relativePath} must be a regular non-symlink file`);
    }
  }
  process.stdout.write('bind sources verified\n');
}

main().catch((error) => {
  process.stderr.write(`bind source check rejected: ${error.message}\n`);
  process.exitCode = 1;
});
