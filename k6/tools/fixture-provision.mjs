#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcrypt';
import pg from 'pg';
import Redis from 'ioredis';

import { fixtureEmail, fixtureId } from '../lib/fixture-range.js';
import { loadConfig } from '../lib/config.js';

const { Pool } = pg;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const TRACKING_TTL_SECONDS = 24 * 60 * 60;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.write-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, filePath);
}

function chunks(total, size) {
  const result = [];
  for (let start = 0; start < total; start += size) {
    result.push({ start, count: Math.min(size, total - start) });
  }
  return result;
}

async function seedUsers(client, config, passwordHash, chunk) {
  const indexes = Array.from(
    { length: chunk.count },
    (_, offset) => chunk.start + offset,
  );
  const ids = indexes.map((index) => fixtureId(config.runId, 'user', index));
  const emails = indexes.map((index) => fixtureEmail(config.runId, index));
  const names = indexes.map((index) => `k6-${config.runId}-${index}`);
  await client.query(
    `INSERT INTO "User" (id, email, password, name, "updatedAt")
     SELECT source.id, source.email, $4, source.name, NOW()
     FROM UNNEST($1::text[], $2::text[], $3::text[]) AS source(id, email, name)
     ON CONFLICT (id) DO NOTHING`,
    [ids, emails, names, passwordHash],
  );
  const verified = await client.query(
    `SELECT COUNT(*)::int AS count
     FROM "User" AS target
     JOIN UNNEST($1::text[], $2::text[]) AS source(id, email)
       ON target.id = source.id AND target.email = source.email`,
    [ids, emails],
  );
  if (verified.rows[0]?.count !== ids.length) {
    throw new Error('fixture user chunk verification failed');
  }
}

async function seedSeats(client, config, chunk) {
  const indexes = Array.from(
    { length: chunk.count },
    (_, offset) => chunk.start + offset,
  );
  const ids = indexes.map((index) => fixtureId(config.runId, 'seat', index));
  const numbers = indexes.map((index) => String(index + 1));
  await client.query(
    `INSERT INTO "Seat" (id, "performanceId", "seatNumber", status, version, "updatedAt")
     SELECT source.id, $3, source.number, 'AVAILABLE'::"SeatStatus", 0, NOW()
     FROM UNNEST($1::text[], $2::text[]) AS source(id, number)
     ON CONFLICT (id) DO NOTHING`,
    [ids, numbers, fixtureId(config.runId, 'performance')],
  );
  const verified = await client.query(
    `SELECT COUNT(*)::int AS count FROM "Seat" WHERE id = ANY($1::text[]) AND "performanceId" = $2`,
    [ids, fixtureId(config.runId, 'performance')],
  );
  if (verified.rows[0]?.count !== ids.length) {
    throw new Error('fixture seat chunk verification failed');
  }
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
    throw new Error('usage: fixture-provision.mjs --execute');
  }
  const config = loadConfig(process.env, { requireExecution: true });
  if (config.isLocal || config.fixtureSeedMode !== 'chunked-bulk') {
    throw new Error('chunked fixture provisioning is remote-only');
  }
  if (config.capacityProfile && config.capacityProfile !== 'unique-seat') {
    throw new Error('chunked fixture provisioning requires unique-seat mode');
  }
  const requestBudget =
    config.scenario === 'capacity-vu'
      ? config.capacityRequestBudget
      : config.scenario === 'capacity-rps'
        ? config.rpsRequestBudget
        : ['spike', 'soak'].includes(config.scenario)
          ? config.loadRequestBudget
          : config.totalRequests;
  if (
    !Number.isInteger(requestBudget) ||
    (['capacity-vu', 'capacity-rps', 'spike', 'soak'].includes(
      config.scenario,
    ) &&
      requestBudget !== config.seatCount)
  ) {
    throw new Error(
      'chunked fixture request budget is incompatible with seat range',
    );
  }
  const password = process.env.FIXTURE_USER_PASSWORD || '';
  if (!/^[\x21-\x7E]{32,128}$/.test(password)) {
    throw new Error(
      'FIXTURE_USER_PASSWORD must be 32-128 printable ASCII characters',
    );
  }
  const databaseUrl = process.env.AUDIT_DATABASE_URL;
  const redisHost = process.env.AUDIT_REDIS_HOST;
  const redisPort = Number(process.env.AUDIT_REDIS_PORT);
  if (!databaseUrl || !redisHost || !Number.isInteger(redisPort)) {
    throw new Error('fixture database and Redis connections are required');
  }

  const resultDirectory = path.join(repositoryRoot, config.resultDir);
  await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
  const checkpointPath = path.join(resultDirectory, '.fixture-checkpoint.json');
  let checkpoint = {
    schemaVersion: 1,
    runId: config.runId,
    userChunks: {},
    seatChunks: {},
    completed: false,
  };
  try {
    const existing = JSON.parse(await readFile(checkpointPath, 'utf8'));
    if (existing.runId !== config.runId)
      throw new Error('checkpoint owner mismatch');
    checkpoint = existing;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl:
      config.expectedDbTlsMode === 'require'
        ? { rejectUnauthorized: true }
        : false,
    max: 2,
  });
  const redis = new Redis({
    host: redisHost,
    port: redisPort,
    tls: config.expectedRedisTlsMode === 'require' ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  const client = await pool.connect();
  try {
    await redis.connect();
    const passwordHash = await bcrypt.hash(password, 10);
    for (const chunk of chunks(config.userCount, config.fixtureSeedChunkSize)) {
      const key = String(chunk.start);
      const checksum = digest({ kind: 'users', ...chunk, runId: config.runId });
      if (checkpoint.userChunks[key]?.checksum === checksum) continue;
      await client.query('BEGIN');
      try {
        await seedUsers(client, config, passwordHash, chunk);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      checkpoint.userChunks[key] = { ...chunk, checksum, completed: true };
      await atomicJson(checkpointPath, checkpoint);
    }

    const ownerId = fixtureId(config.runId, 'user', 0);
    const eventId = fixtureId(config.runId, 'event');
    const performanceId = fixtureId(config.runId, 'performance');
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO "Event" (id, title, description, "userId", "updatedAt")
         VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (id) DO NOTHING`,
        [eventId, `k6-${config.runId}`, `Run ${config.runId}`, ownerId],
      );
      await client.query(
        `INSERT INTO "Performance" (id, "eventId", "startAt", "totalSeats", "availableSeats", "updatedAt")
         VALUES ($1, $2, NOW() + INTERVAL '1 day', $3, $3, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [performanceId, eventId, config.seatCount],
      );
      const boundary = await client.query(
        `SELECT e."userId" AS owner,
                p."eventId" AS event,
                p."totalSeats"::int AS total
         FROM "Event" e JOIN "Performance" p ON p."eventId" = e.id
         WHERE e.id = $1 AND p.id = $2`,
        [eventId, performanceId],
      );
      if (
        boundary.rows.length !== 1 ||
        boundary.rows[0].owner !== ownerId ||
        boundary.rows[0].event !== eventId ||
        boundary.rows[0].total !== config.seatCount
      ) {
        throw new Error('fixture event boundary conflicts with existing data');
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    for (const chunk of chunks(config.seatCount, config.fixtureSeedChunkSize)) {
      const key = String(chunk.start);
      const checksum = digest({ kind: 'seats', ...chunk, runId: config.runId });
      if (checkpoint.seatChunks[key]?.checksum === checksum) continue;
      await client.query('BEGIN');
      try {
        await seedSeats(client, config, chunk);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      if (config.cacheProfile === 'warm') {
        const pipeline = redis.pipeline();
        for (let offset = 0; offset < chunk.count; offset += 1) {
          pipeline.set(
            `seat:${fixtureId(config.runId, 'seat', chunk.start + offset)}:status`,
            'AVAILABLE',
            'EX',
            TRACKING_TTL_SECONDS,
          );
        }
        const results = await pipeline.exec();
        if (!results || results.some(([error]) => error)) {
          throw new Error('fixture cache chunk failed');
        }
      }
      checkpoint.seatChunks[key] = { ...chunk, checksum, completed: true };
      await atomicJson(checkpointPath, checkpoint);
    }

    const base = `${config.redisKeyPrefix}run:${config.runId}:`;
    const fixture = {
      schemaVersion: 2,
      runId: config.runId,
      scenario: config.scenario,
      cacheProfile: config.cacheProfile,
      capacityProfile: 'unique-seat',
      eventId,
      performanceId,
      userRange: {
        kind: 'deterministic-v1',
        start: 0,
        count: config.userCount,
      },
      seatRange: {
        kind: 'deterministic-v1',
        start: 0,
        count: config.seatCount,
      },
      requestManifest: {
        schemaVersion: 3,
        requestBudget,
        assignment:
          requestBudget <= config.seatCount
            ? 'deterministic_range_unique_seat'
            : 'deterministic_range_modulo_seat',
      },
    };
    const stored = await redis.set(
      `${base}fixture`,
      JSON.stringify(fixture),
      'EX',
      TRACKING_TTL_SECONDS,
      'NX',
    );
    if (
      stored !== 'OK' &&
      (await redis.get(`${base}fixture`)) !== JSON.stringify(fixture)
    ) {
      throw new Error('fixture boundary conflicts with an existing run');
    }
    await redis.hset(
      `${base}state`,
      'producer',
      'PREPARED',
      'cache_profile',
      config.cacheProfile,
      'createdAt',
      new Date().toISOString(),
    );
    await redis.hset(
      `${base}counters`,
      'enqueue',
      '0',
      'attempts',
      '0',
      'processing_started',
      '0',
      'processed_success',
      '0',
      'processed_failure',
      '0',
      'retry',
      '0',
      'dlq',
      '0',
      'worker_in_flight',
      '0',
      'max_queue_depth',
      '0',
    );
    await Promise.all([
      redis.expire(`${base}state`, TRACKING_TTL_SECONDS),
      redis.expire(`${base}counters`, TRACKING_TTL_SECONDS),
    ]);
    checkpoint.completed = true;
    checkpoint.completedAt = new Date().toISOString();
    checkpoint.fixtureChecksum = digest(fixture);
    await atomicJson(checkpointPath, checkpoint);
    process.stdout.write(`fixture provisioned: ${config.runId}\n`);
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
    redis.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`fixture provisioning rejected: ${error.message}\n`);
  process.exitCode = 1;
});
