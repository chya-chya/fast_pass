#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

import { buildCleanupPlan } from '../lib/cleanup.js';
import { isLoopbackHostname, loadConfig } from '../lib/config.js';
import { fixtureId } from '../lib/fixture-range.js';
import { verifyArtifacts } from './artifact-state.mjs';

const { Pool } = pg;
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');
const RESERVATION_STREAM = '{queue:reservations}:stream:v1';
const RESERVATION_DLQ = '{queue:reservations}:dlq:v1';
const TERMINAL_PREFIX = '{queue:reservations}:terminal:';

function nextStreamId(streamId) {
  const [milliseconds, sequence] = streamId.split('-').map(Number);
  return `${milliseconds}-${sequence + 1}`;
}

function streamFields(raw) {
  const values = {};
  for (let index = 0; index < raw.length; index += 2) {
    values[raw[index]] = raw[index + 1];
  }
  return values;
}

async function inspectOwnedStreamEntries(redis, stream, runId, execute) {
  let cursor = '-';
  let owned = 0;
  let foreign = 0;
  let terminalKeys = 0;
  while (true) {
    const rows = await redis.xrange(stream, cursor, '+', 'COUNT', 1000);
    if (rows.length === 0) break;
    const ownedIds = [];
    const keys = [];
    for (const [streamId, rawFields] of rows) {
      const fields = streamFields(rawFields);
      let payload = null;
      try {
        payload = fields.payload ? JSON.parse(fields.payload) : null;
      } catch {
        payload = null;
      }
      if (payload?.runId === runId || fields.runId === runId) {
        owned += 1;
        ownedIds.push(streamId);
        const reservationId = fields.reservationId || payload?.id;
        if (reservationId) {
          keys.push(`${TERMINAL_PREFIX}${reservationId}:${streamId}`);
        }
      } else {
        foreign += 1;
      }
    }
    if (execute && ownedIds.length > 0) await redis.xdel(stream, ...ownedIds);
    if (execute && keys.length > 0) terminalKeys += await redis.del(...keys);
    cursor = nextStreamId(rows.at(-1)[0]);
    if (rows.length < 1000) break;
  }
  return { owned, foreign, terminalKeys };
}

async function cleanupOwnedStreams(redis, runId) {
  const deleted = { streamEntries: 0, dlqEntries: 0, terminalKeys: 0 };
  for (const [stream, field] of [
    [RESERVATION_STREAM, 'streamEntries'],
    [RESERVATION_DLQ, 'dlqEntries'],
  ]) {
    const before = await inspectOwnedStreamEntries(redis, stream, runId, true);
    const after = await inspectOwnedStreamEntries(redis, stream, runId, false);
    if (after.owned !== 0 || after.foreign !== before.foreign) {
      throw new Error('exact queue cleanup verification failed');
    }
    deleted[field] = before.owned;
    deleted.terminalKeys += before.terminalKeys;
  }
  return deleted;
}

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
  if (!config.isLocal && process.env.REMOTE_CLEANUP_AUTHORIZED !== 'true') {
    throw new Error('REMOTE_CLEANUP_AUTHORIZED=true is required');
  }
  const databaseUrl = process.env.AUDIT_DATABASE_URL;
  const redisHost = process.env.AUDIT_REDIS_HOST || '';
  const redisPort = Number(process.env.AUDIT_REDIS_PORT || '');
  if (!databaseUrl) throw new Error('cleanup database connection is required');
  const parsedDatabaseUrl = new URL(databaseUrl);
  if (
    parsedDatabaseUrl.pathname.slice(1) !== config.testDatabaseName ||
    !Number.isInteger(redisPort) ||
    redisPort < 1 ||
    redisPort > 65535
  ) {
    throw new Error('cleanup target identity does not match');
  }
  if (
    config.isLocal !==
      (isLoopbackHostname(parsedDatabaseUrl.hostname) &&
        isLoopbackHostname(redisHost)) ||
    (!config.isLocal && process.env.REMOTE_APPROVAL_VERIFIED !== 'true')
  ) {
    throw new Error('cleanup network boundary does not match approval mode');
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

    if (plan.schemaVersion === 2) {
      const foreignBefore = await client.query(
        `SELECT COUNT(*)::int AS count FROM "Reservation"
         WHERE "testRunId" IS DISTINCT FROM $1`,
        [config.runId],
      );
      await client.query('BEGIN');
      const deleted = {
        reservations: (
          await client.query(
            `DELETE FROM "Reservation" WHERE "testRunId" = $1`,
            [config.runId],
          )
        ).rowCount,
        seats: 0,
        performances: 0,
        events: 0,
        users: 0,
      };
      const chunkSize = Math.max(
        100,
        Math.min(config.fixtureSeedChunkSize || 1000, 10000),
      );
      for (
        let start = 0;
        start < plan.database.seatRange.count;
        start += chunkSize
      ) {
        const count = Math.min(
          chunkSize,
          plan.database.seatRange.count - start,
        );
        const ids = Array.from({ length: count }, (_, offset) =>
          fixtureId(config.runId, 'seat', start + offset),
        );
        deleted.seats += await deleteIds(client, 'Seat', ids);
      }
      deleted.performances += await deleteIds(client, 'Performance', [
        plan.database.performanceId,
      ]);
      deleted.events += await deleteIds(client, 'Event', [
        plan.database.eventId,
      ]);
      for (
        let start = 0;
        start < plan.database.userRange.count;
        start += chunkSize
      ) {
        const count = Math.min(
          chunkSize,
          plan.database.userRange.count - start,
        );
        const ids = Array.from({ length: count }, (_, offset) =>
          fixtureId(config.runId, 'user', start + offset),
        );
        deleted.users += await deleteIds(client, 'User', ids);
      }
      await client.query('COMMIT');

      const fixedRunKeys = [
        'fixture',
        'state',
        'counters',
        'attempted_bitmap',
        'accepted_bitmap',
        'processing_bitmap',
        'processed_bitmap',
        'terminal_success_bitmap',
        'terminal_failure_bitmap',
      ].map((suffix) => `${plan.redis.runBase}${suffix}`);
      if (fixedRunKeys.length > 0) await redis.del(...fixedRunKeys);
      for (
        let start = 0;
        start < plan.database.seatRange.count;
        start += chunkSize
      ) {
        const count = Math.min(
          chunkSize,
          plan.database.seatRange.count - start,
        );
        const keys = Array.from({ length: count }, (_, offset) => {
          const id = fixtureId(config.runId, 'seat', start + offset);
          return [`seat:${id}:status`, `locks:seats:${id}`];
        }).flat();
        if (keys.length > 0) await redis.del(...keys);
      }
      const [remaining, foreignAfter] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS count FROM "Reservation" WHERE "testRunId" = $1`,
          [config.runId],
        ),
        client.query(
          `SELECT COUNT(*)::int AS count FROM "Reservation"
           WHERE "testRunId" IS DISTINCT FROM $1`,
          [config.runId],
        ),
      ]);
      if (
        remaining.rows[0]?.count !== 0 ||
        foreignAfter.rows[0]?.count !== foreignBefore.rows[0]?.count
      ) {
        throw new Error('exact cleanup verification failed');
      }
      const queues = await cleanupOwnedStreams(redis, config.runId);
      return { ...deleted, ...queues, remaining: 0, foreignPreserved: true };
    }

    const foreignBefore = !config.isLocal
      ? await client.query(
          `SELECT COUNT(*)::int AS count FROM "Reservation"
           WHERE "testRunId" IS DISTINCT FROM $1`,
          [config.runId],
        )
      : null;
    await client.query('BEGIN');
    const deleted = {
      reservations: config.isLocal
        ? await deleteIds(client, 'Reservation', plan.database.reservationIds)
        : (
            await client.query(
              `DELETE FROM "Reservation" WHERE "testRunId" = $1`,
              [config.runId],
            )
          ).rowCount,
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
    if (!config.isLocal) {
      const [remaining, foreignAfter] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::int AS count FROM "Reservation"
           WHERE "testRunId" = $1`,
          [config.runId],
        ),
        client.query(
          `SELECT COUNT(*)::int AS count FROM "Reservation"
           WHERE "testRunId" IS DISTINCT FROM $1`,
          [config.runId],
        ),
      ]);
      if (
        remaining.rows[0]?.count !== 0 ||
        foreignAfter.rows[0]?.count !== foreignBefore.rows[0]?.count
      ) {
        throw new Error('exact cleanup verification failed');
      }
      const queues = await cleanupOwnedStreams(redis, config.runId);
      return { ...deleted, ...queues, remaining: 0, foreignPreserved: true };
    }
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
  const result = {
    ...plan,
    mode: 'executed',
    executedAt: new Date().toISOString(),
    deleted,
    verification: {
      runOwnedRowsRemaining: deleted.remaining ?? null,
      foreignRunDataPreserved: deleted.foreignPreserved ?? null,
    },
  };
  const cleanupPath = path.join(resultDirectory, 'cleanup.json');
  const temporary = `${cleanupPath}.write-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, cleanupPath);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`cleanup rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
