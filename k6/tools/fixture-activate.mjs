#!/usr/bin/env node

import Redis from 'ioredis';

import { loadConfig } from '../lib/config.js';

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
    throw new Error('usage: fixture-activate.mjs --execute');
  }
  const config = loadConfig(process.env, { requireExecution: true });
  if (config.isLocal || config.fixtureSeedMode !== 'chunked-bulk') {
    throw new Error('fixture activation is remote chunked-bulk only');
  }
  const redis = new Redis({
    host: process.env.AUDIT_REDIS_HOST,
    port: Number(process.env.AUDIT_REDIS_PORT),
    tls: config.expectedRedisTlsMode === 'require' ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    const base = `${config.redisKeyPrefix}run:${config.runId}:`;
    const fixture = JSON.parse((await redis.get(`${base}fixture`)) || 'null');
    const producer = await redis.hget(`${base}state`, 'producer');
    if (fixture?.runId !== config.runId || producer !== 'PREPARED') {
      throw new Error('fixture is not prepared for activation');
    }
    await redis.hset(`${base}state`, 'producer', 'OPEN');
    process.stdout.write(`fixture activated: ${config.runId}\n`);
  } finally {
    redis.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`fixture activation rejected: ${error.message}\n`);
  process.exitCode = 1;
});
