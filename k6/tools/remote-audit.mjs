#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

import { loadConfig } from '../lib/config.js';

const { Pool } = pg;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const STREAM = '{queue:reservations}:stream:v1';
const GROUP = 'reservation-workers-v1';
const DLQ = '{queue:reservations}:dlq:v1';

async function atomicWrite(filePath, value) {
  const temporary = `${filePath}.write-${process.pid}`;
  await writeFile(temporary, value, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function numericHash(value) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, Number(item)]),
  );
}

async function queueState(redis) {
  const pending = await redis.xpending(STREAM, GROUP).catch((error) => {
    if (error instanceof Error && error.message.includes('NOGROUP')) return [0];
    throw error;
  });
  return {
    pending: Number(pending?.[0] || 0),
    stream: Number(await redis.xlen(STREAM)),
    dlq: Number(await redis.xlen(DLQ)),
  };
}

async function main() {
  const config = loadConfig(process.env, { requireExecution: true });
  if (config.isLocal || config.fixtureSeedMode !== 'chunked-bulk') {
    throw new Error('remote range audit requires chunked-bulk mode');
  }
  const resultDirectory = path.join(repositoryRoot, config.resultDir);
  const summary = JSON.parse(
    await readFile(path.join(resultDirectory, '.summary.json.tmp'), 'utf8'),
  );
  const checkpoint = JSON.parse(
    await readFile(
      path.join(resultDirectory, '.fixture-checkpoint.json'),
      'utf8',
    ),
  );
  if (!checkpoint.completed || checkpoint.runId !== config.runId) {
    throw new Error('fixture checkpoint is incomplete');
  }
  const pool = new Pool({
    connectionString: process.env.AUDIT_DATABASE_URL,
    ssl:
      config.expectedDbTlsMode === 'require'
        ? { rejectUnauthorized: true }
        : false,
    max: 2,
  });
  const redis = new Redis({
    host: process.env.AUDIT_REDIS_HOST,
    port: Number(process.env.AUDIT_REDIS_PORT),
    tls: config.expectedRedisTlsMode === 'require' ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  try {
    await redis.connect();
    const identity = await pool.query('SELECT current_database() AS name');
    const markerText = await redis.get(`${config.redisKeyPrefix}environment`);
    const marker = markerText ? JSON.parse(markerText) : null;
    if (
      identity.rows[0]?.name !== config.testDatabaseName ||
      marker?.testEnvId !== config.testEnvId ||
      marker?.redisId !== config.testRedisId ||
      marker?.keyPrefix !== config.redisKeyPrefix
    ) {
      throw new Error('remote audit environment identity does not match');
    }
    const base = `${config.redisKeyPrefix}run:${config.runId}:`;
    const fixtureText = await redis.get(`${base}fixture`);
    const fixture = fixtureText ? JSON.parse(fixtureText) : null;
    const approvedRequestBudget =
      config.scenario === 'capacity-vu'
        ? config.capacityRequestBudget
        : config.scenario === 'capacity-rps'
          ? config.rpsRequestBudget
          : ['spike', 'soak'].includes(config.scenario)
            ? config.loadRequestBudget
            : config.totalRequests;
    const expectedAssignment =
      approvedRequestBudget <= config.seatCount
        ? 'deterministic_range_unique_seat'
        : 'deterministic_range_modulo_seat';
    if (
      fixture?.schemaVersion !== 2 ||
      fixture.runId !== config.runId ||
      fixture.userRange?.count !== config.userCount ||
      fixture.seatRange?.count !== config.seatCount ||
      fixture.requestManifest?.schemaVersion !== 3 ||
      fixture.requestManifest?.requestBudget !== approvedRequestBudget ||
      fixture.requestManifest?.assignment !== expectedAssignment
    ) {
      throw new Error('remote fixture boundary is invalid');
    }

    const started = Date.now();
    const timeoutMs = Number(process.env.AUDIT_TIMEOUT_MS || 300000);
    let state;
    let counters;
    let queues;
    do {
      [state, counters, queues] = await Promise.all([
        redis.hgetall(`${base}state`),
        redis.hgetall(`${base}counters`).then(numericHash),
        queueState(redis),
      ]);
      if (
        state.producer === 'COMPLETED' &&
        queues.pending === 0 &&
        Number(counters.worker_in_flight || 0) === 0
      ) {
        break;
      }
      await sleep(250);
    } while (Date.now() - started <= timeoutMs);
    const drained =
      state.producer === 'COMPLETED' &&
      queues.pending === 0 &&
      Number(counters.worker_in_flight || 0) === 0;

    const [attempted, accepted, processed, failed, processing] =
      await Promise.all([
        redis.bitcount(`${base}attempted_bitmap`),
        redis.bitcount(`${base}accepted_bitmap`),
        redis.bitcount(`${base}processed_bitmap`),
        redis.bitcount(`${base}terminal_failure_bitmap`),
        redis.bitcount(`${base}processing_bitmap`),
      ]);
    const database = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(DISTINCT "testRequestId")::int AS distinct_requests,
              COUNT(*) FILTER (WHERE "testRequestId" IS NULL)::int AS missing_request_id,
              COUNT(*) FILTER (
                WHERE "seatId" <> $1 || '-seat-' || LPAD(
                  (MOD(
                    SUBSTRING("testRequestId" FROM '([0-9]{6,8})$')::int,
                    $2::int
                  ))::text, 8, '0'
                )
              )::int AS assignment_mismatch
       FROM "Reservation" WHERE "testRunId" = $1`,
      [config.runId, config.seatCount],
    );
    const duplicateRequests = await pool.query(
      `SELECT COUNT(*)::int AS count FROM (
         SELECT "testRequestId" FROM "Reservation"
         WHERE "testRunId" = $1 GROUP BY "testRequestId" HAVING COUNT(*) > 1
       ) duplicates`,
      [config.runId],
    );
    const databaseCounts = database.rows[0];
    const expectedCount = Number(
      config.scenario === 'capacity-vu'
        ? summary.metrics?.reservation_requests?.values?.count || 0
        : config.scenario === 'capacity-rps'
          ? summary.rpsLoad?.startedReservationRequests || 0
          : ['spike', 'soak'].includes(config.scenario)
            ? summary.longRunLoad?.startedReservationRequests || 0
            : summary.metrics?.reservation_requests?.values?.count || 0,
    );
    const reasons = [];
    if (!drained) reasons.push('DRAIN_TIMEOUT');
    if (queues.dlq !== 0 || Number(counters.dlq || 0) !== 0)
      reasons.push('DLQ_NOT_EMPTY');
    if (attempted !== expectedCount)
      reasons.push('REQUEST_ATTEMPT_COUNT_MISMATCH');
    if (accepted !== Number(summary.metrics?.accepted?.values?.count || 0))
      reasons.push('ACCEPTED_COUNT_MISMATCH');
    if (processed !== accepted) reasons.push('PROCESSED_COUNT_MISMATCH');
    if (Number(databaseCounts.total) !== accepted)
      reasons.push('PERSISTED_COUNT_MISMATCH');
    if (Number(databaseCounts.distinct_requests) !== accepted)
      reasons.push('PERSISTED_REQUEST_ID_MISMATCH');
    if (Number(databaseCounts.missing_request_id) !== 0)
      reasons.push('MISSING_REQUEST_ID');
    if (Number(databaseCounts.assignment_mismatch) !== 0)
      reasons.push('REQUEST_ASSIGNMENT_MISMATCH');
    if (Number(duplicateRequests.rows[0]?.count || 0) !== 0)
      reasons.push('DUPLICATE_REQUEST_ID');
    if (failed !== 0 || processing !== 0) reasons.push('TERMINAL_FAILURE');

    const watchdog = JSON.parse(
      await readFile(path.join(resultDirectory, '.watchdog.json.tmp'), 'utf8'),
    );
    if (watchdog.status !== 'COMPLETED' || watchdog.monitoringFailures !== 0) {
      reasons.push(watchdog.abortReason || 'WATCHDOG_INCOMPLETE');
    }
    const pass = reasons.length === 0;
    const verdictKind =
      config.scenario === 'capacity-vu'
        ? 'exploratory'
        : config.scenario === 'capacity-rps'
          ? summary.verdict?.kind || 'capacity'
          : config.scenario === 'spike'
            ? 'recovery-qualification'
            : 'endurance-qualification';
    const experimentVerdict = {
      kind: verdictKind,
      status:
        pass && summary.thresholdPassed
          ? summary.verdict?.status || 'PASS'
          : 'FAIL',
      reasons: [
        ...reasons,
        ...(summary.thresholdPassed ? [] : ['K6_THRESHOLD_FAILED']),
      ],
      integrationChecksPassed: pass,
    };
    const audit = {
      schemaVersion: 2,
      runId: config.runId,
      testEnvId: config.testEnvId,
      drain: {
        timedOut: !drained,
        timeoutMs,
        elapsedMs: Date.now() - started,
      },
      queues: {
        pending: queues.pending,
        processing,
        retry: Number(counters.retry || 0),
        dlq: queues.dlq,
        stream: queues.stream,
      },
      counters,
      aggregateIds: { attempted, accepted, processed, failed },
      database: {
        reservationCount: Number(databaseCounts.total),
        distinctRequestCount: Number(databaseCounts.distinct_requests),
        duplicateRequestCount: Number(duplicateRequests.rows[0]?.count || 0),
        assignmentMismatchCount: Number(databaseCounts.assignment_mismatch),
      },
      requestAudit: {
        expectedCount,
        actualCount: attempted,
        expectedAccepted: accepted,
        actualAccepted: Number(databaseCounts.total),
      },
      consistency: { pass, reasons },
      experimentVerdict,
    };
    const fixtureManifest = {
      schemaVersion: 2,
      runId: config.runId,
      testEnvId: config.testEnvId,
      scenario: config.scenario,
      eventId: fixture.eventId,
      performanceId: fixture.performanceId,
      userRange: fixture.userRange,
      seatRange: fixture.seatRange,
      requestRange: {
        kind: 'deterministic-v1',
        start: 0,
        count: expectedCount,
      },
      reservationOwnership: { field: 'testRunId', value: config.runId },
      chunkCheckpointSha256: checkpoint.fixtureChecksum,
      counts: {
        users: config.userCount,
        events: 1,
        performances: 1,
        seats: config.seatCount,
        requestAttempts: attempted,
        acceptedReservations: accepted,
      },
    };
    const databaseStats = await pool.query(
      `SELECT numbackends::int AS connections,
              xact_commit::bigint::text AS "transactionsCommitted",
              xact_rollback::bigint::text AS "transactionsRolledBack"
       FROM pg_stat_database WHERE datname = current_database()`,
    );
    const redisInfo = await redis.info();
    const redisSummary = Object.fromEntries(
      redisInfo
        .split(/\r?\n/)
        .map((line) => line.split(':'))
        .filter(([key]) =>
          ['connected_clients', 'used_memory', 'evicted_keys'].includes(key),
        )
        .map(([key, value]) => [key, Number(value)]),
    );
    const serverMetrics = {
      schemaVersion: 2,
      runId: config.runId,
      window: {
        startedAt: watchdog.startedAt,
        finishedAt: watchdog.finishedAt,
        timezone: 'UTC',
      },
      app: {
        status: watchdog.monitoringFailures === 0 ? 'available' : 'unavailable',
        reason:
          watchdog.monitoringFailures === 0
            ? null
            : 'worker metrics were incomplete',
        valid: watchdog.monitoringFailures === 0,
        missingMetrics:
          watchdog.monitoringFailures === 0 ? [] : ['worker metrics'],
        summary: {
          maxima: watchdog.maxima,
          minima: watchdog.minima,
          trends: watchdog.trends,
        },
      },
      database: {
        status: 'available',
        reason: null,
        summary: databaseStats.rows[0] || {},
      },
      redis: { status: 'available', reason: null, summary: redisSummary },
      pm2: {
        status: watchdog.monitoringFailures === 0 ? 'available' : 'unavailable',
        reason:
          watchdog.monitoringFailures === 0
            ? null
            : 'PM2 metrics were incomplete',
        workers: 14,
        processRestarts: watchdog.processRestarts,
      },
      load:
        summary.longRunLoad ||
        summary.rpsLoad ||
        (summary.capacityStages
          ? { capacityStages: summary.capacityStages }
          : null),
      watchdog,
      rawTimeseries: { status: 'pending-upload' },
    };
    const report = [
      `# k6 Run ${config.runId}`,
      '',
      '## 목표',
      '',
      '승인된 AWS 원격 환경의 전체 시스템 한계와 정합성을 검증한다.',
      '',
      '## 조건',
      '',
      `- Environment: ${config.testEnvId}`,
      `- Scenario: ${config.scenario}`,
      `- Request budget: ${approvedRequestBudget}`,
      '',
      '## 정합성 결과',
      '',
      `- Verdict: ${pass ? 'PASS' : 'FAIL'}`,
      `- Reasons: ${reasons.length ? reasons.join(', ') : 'none'}`,
      `- Attempted / accepted / processed / persisted: ${attempted} / ${accepted} / ${processed} / ${databaseCounts.total}`,
      '',
      '## 한계',
      '',
      '- 결과는 db.t4g.micro RDS와 cache.t3.micro Redis를 포함한 전체 시스템 한계다.',
      '- CPU credit, DB 또는 Redis 포화 Run은 앱 단독 성능 근거로 사용하지 않는다.',
      '',
      '## 다음 결정',
      '',
      pass
        ? '- cleanup dry-run과 exact cleanup, S3 봉인을 수행한다.'
        : '- 다음 Run을 중단하고 정합성 및 watchdog 실패 원인을 조사한다.',
      '',
    ].join('\n');
    await Promise.all([
      atomicWrite(
        path.join(resultDirectory, '.fixture-manifest.json.tmp'),
        `${JSON.stringify(fixtureManifest, null, 2)}\n`,
      ),
      atomicWrite(
        path.join(resultDirectory, '.consistency-audit.json.tmp'),
        `${JSON.stringify(audit, null, 2)}\n`,
      ),
      atomicWrite(
        path.join(resultDirectory, '.server-metrics.json.tmp'),
        `${JSON.stringify(serverMetrics, null, 2)}\n`,
      ),
      atomicWrite(path.join(resultDirectory, '.report.md.tmp'), report),
    ]);
    if (!pass) process.exitCode = 2;
  } finally {
    await pool.end().catch(() => undefined);
    redis.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`remote audit rejected: ${error.message}\n`);
  process.exitCode = 1;
});
