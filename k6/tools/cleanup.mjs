#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

import { buildCleanupPlan } from '../lib/cleanup.js';
import { isLoopbackHostname, loadConfig } from '../lib/config.js';
import { verifyArtifacts } from './artifact-state.mjs';

const { Pool } = pg;
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');

async function deleteIds(client, table, ids) {
  if (ids.length === 0) return 0;
  const statements = {
    Reservation: 'DELETE FROM "Reservation" WHERE id = ANY($1::text[])',
    Seat: 'DELETE FROM "Seat" WHERE id = ANY($1::text[])',
    Performance: 'DELETE FROM "Performance" WHERE id = ANY($1::text[])',
    Event: 'DELETE FROM "Event" WHERE id = ANY($1::text[])',
    User: 'DELETE FROM "User" WHERE id = ANY($1::text[])',
  };
  const statement = statements[table];
  if (!statement) throw new Error('cleanup table is invalid');
  const result = await client.query(statement, [ids]);
  return result.rowCount;
}

async function executeCleanup(config, plan) {
  if (process.env.ALLOW_TEST_DATA_DELETE !== 'true') {
    throw new Error('ALLOW_TEST_DATA_DELETE=true is required');
  }
  const databaseUrl = process.env.AUDIT_DATABASE_URL;
  const redisHost = process.env.AUDIT_REDIS_HOST || '';
  const redisPort = Number(process.env.AUDIT_REDIS_PORT || '');
  if (!databaseUrl) throw new Error('cleanup database connection is required');
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (
    !isLoopbackHostname(parsedDatabaseUrl.hostname) ||
    parsedDatabaseUrl.pathname.slice(1) !== config.testDatabaseName ||
    !isLoopbackHostname(redisHost) ||
    !Number.isInteger(redisPort) ||
    redisPort < 1 ||
    redisPort > 65535
  ) {
    throw new Error('cleanup target identity does not match');
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      config.expectedDbTlsMode === 'require'
        ? { rejectUnauthorized: true }
        : false,
    max: 1,
  });
  const redis = new Redis({
    host: redisHost,
    port: redisPort,
    tls: config.expectedRedisTlsMode === 'require' ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  const client = await pool.connect();
  try {
    await redis.connect();
    const identity = await client.query('SELECT current_database() AS name');
    const markerText = await redis.get(`${config.redisKeyPrefix}environment`);
    const marker = markerText ? JSON.parse(markerText) : null;
    if (
      identity.rows[0]?.name !== config.testDatabaseName ||
      marker?.testEnvId !== config.testEnvId ||
      marker?.redisId !== config.testRedisId
    ) {
      throw new Error('cleanup environment identity does not match');
    }

    await client.query('BEGIN');
    const deleted = {
      reservations: await deleteIds(
        client,
        'Reservation',
        plan.database.reservationIds,
      ),
      seats: await deleteIds(client, 'Seat', plan.database.seatIds),
      performances: await deleteIds(
        client,
        'Performance',
        plan.database.performanceIds,
      ),
      events: await deleteIds(client, 'Event', plan.database.eventIds),
      users: await deleteIds(client, 'User', plan.database.userIds),
    };
    await client.query('COMMIT');
    if (plan.redis.keys.length > 0) await redis.del(...plan.redis.keys);
    return deleted;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
    redis.disconnect();
  }
}

async function main() {
  const mode = process.argv[2] || '--dry-run';
  if (!['--dry-run', '--execute'].includes(mode) || process.argv.length > 3) {
    throw new Error('usage: cleanup.mjs [--dry-run|--execute]');
  }
  const config = loadConfig(process.env, { requireExecution: true });
  await verifyArtifacts(config);
  const resultDirectory = path.resolve(repositoryRoot, config.resultDir);
  const fixture = JSON.parse(
    await readFile(path.join(resultDirectory, 'fixture-manifest.json'), 'utf8'),
  );
  const metadata = JSON.parse(
    await readFile(path.join(resultDirectory, 'metadata.json'), 'utf8'),
  );
  if (
    metadata.artifactSet !== 'FINALIZED' ||
    metadata.preflight !== 'VERIFIED'
  ) {
    throw new Error('cleanup requires a finalized verified artifact set');
  }
  const plan = buildCleanupPlan(config, fixture);
  if (mode === '--dry-run') {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  const deleted = await executeCleanup(config, plan);
  process.stdout.write(
    `${JSON.stringify({ ...plan, mode: 'executed', deleted }, null, 2)}\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`cleanup rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
