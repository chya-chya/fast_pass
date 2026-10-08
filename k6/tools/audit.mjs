#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

import {
  buildConsistencyAudit,
  drainSignature,
  isDrainCandidate,
} from '../lib/audit.js';
import { buildCapacityExpectedRequestManifest } from '../lib/capacity.js';
import { isLoopbackHostname, loadConfig } from '../lib/config.js';
import { buildExpectedRequestManifest } from '../lib/consistency.js';
import {
  APP_METRIC_NAMES,
  parsePrometheusSnapshot,
  summarizePrometheusWindow,
} from '../lib/prometheus.js';

const { Pool } = pg;
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');
const RESERVATION_STREAM = '{queue:reservations}:stream:v1';
const RESERVATION_DLQ_STREAM = '{queue:reservations}:dlq:v1';
const RESERVATION_CONSUMER_GROUP = 'reservation-workers-v1';
const MAX_METRICS_BYTES = 2 * 1024 * 1024;

function integerEnvironment(name, fallback, minimum, maximum) {
  const raw = process.env[name] || String(fallback);
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} is invalid`);
  const value = Number(raw);
  if (value < minimum || value > maximum) throw new Error(`${name} is invalid`);
  return value;
}

function numericHash(hash) {
  return Object.fromEntries(
    Object.entries(hash).map(([key, value]) => [key, Number(value)]),
  );
}

function distribution(rows) {
  return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)]));
}

function parseRedisInfo(raw) {
  const allowed = new Set([
    'connected_clients',
    'used_memory',
    'instantaneous_ops_per_sec',
    'evicted_keys',
  ]);
  const result = {};
  for (const line of raw.split('\n')) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator);
    if (!allowed.has(key)) continue;
    result[key] = Number(line.slice(separator + 1).trim());
  }
  return result;
}

async function collectApplicationMetrics(config, resultDirectory) {
  try {
    const baseline = JSON.parse(
      await readFile(
        path.join(resultDirectory, '.app-metrics-baseline.json.tmp'),
        'utf8',
      ),
    );
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
    const end = parsePrometheusSnapshot(raw);
    const summary = summarizePrometheusWindow(baseline, end);
    const valid =
      summary.missingMetrics.length === 0 &&
      !summary.counterResetDetected &&
      summary.queue.collectionUp === 1 &&
      summary.queue.retryScanComplete === 1;
    return {
      status: 'available',
      reason: valid ? null : 'required application metrics are incomplete',
      valid,
      sourceUri: null,
      sourceType: 'direct_metrics_window_snapshot',
      rawQueries: [
        {
          endpointPath: '/metrics',
          metricNames: APP_METRIC_NAMES,
          timezone: 'UTC',
        },
      ],
      missingMetrics: summary.missingMetrics,
      summary,
    };
  } catch {
    return {
      status: 'unavailable',
      reason: 'application metrics window could not be collected',
      valid: false,
      sourceUri: null,
      sourceType: 'direct_metrics_window_snapshot',
      rawQueries: [
        {
          endpointPath: '/metrics',
          metricNames: APP_METRIC_NAMES,
          timezone: 'UTC',
        },
      ],
      missingMetrics: APP_METRIC_NAMES,
      summary: null,
    };
  }
}

async function atomicTempWrite(filePath, value) {
  const writePath = `${filePath}.write-${process.pid}`;
  await writeFile(writePath, value, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await rename(writePath, filePath);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function countForeignMessages(messages, runId) {
  let count = 0;
  for (const raw of messages) {
    try {
      if (JSON.parse(raw).runId !== runId) count += 1;
    } catch (_) {
      count += 1;
    }
  }
  return count;
}

function pairsToObject(values) {
  return Object.fromEntries(
    Array.from({ length: values.length / 2 }, (_, index) => [
      String(values[index * 2]),
      values[index * 2 + 1],
    ]),
  );
}

async function readQueueState(redis) {
  let pending = await redis.xlen(RESERVATION_STREAM);
  let processing = 0;
  let retry = 0;
  try {
    const groups = await redis.xinfo('GROUPS', RESERVATION_STREAM);
    const group = groups
      .map(pairsToObject)
      .find((candidate) => candidate.name === RESERVATION_CONSUMER_GROUP);
    if (group) {
      pending = Number(group.lag || 0);
      processing = Number(group.pending || 0);
      if (processing > 0) {
        const entries = await redis.xpending(
          RESERVATION_STREAM,
          RESERVATION_CONSUMER_GROUP,
          '-',
          '+',
          Math.max(processing, 1),
        );
        retry = entries.filter((entry) => Number(entry[3]) > 1).length;
      }
    }
  } catch (error) {
    if (!String(error?.message || error).includes('no such key')) throw error;
  }
  return {
    pending,
    processing,
    retry,
    dlq: await redis.xlen(RESERVATION_DLQ_STREAM),
  };
}

async function readStreamPayloads(redis, stream) {
  const entries = await redis.xrange(stream, '-', '+');
  return entries.map(([, fields]) => pairsToObject(fields).payload || '');
}

async function main() {
  const config = loadConfig(process.env, { requireExecution: true });
  const databaseUrl = process.env.AUDIT_DATABASE_URL;
  const redisHost = process.env.AUDIT_REDIS_HOST || '';
  const redisPort = Number(process.env.AUDIT_REDIS_PORT || '');
  if (!databaseUrl) throw new Error('audit database connection is required');
  let parsedDatabaseUrl;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch (_) {
    throw new Error('audit database connection is invalid');
  }
  if (
    !isLoopbackHostname(parsedDatabaseUrl.hostname) ||
    parsedDatabaseUrl.pathname.slice(1) !== config.testDatabaseName ||
    !isLoopbackHostname(redisHost) ||
    !Number.isInteger(redisPort) ||
    redisPort < 1 ||
    redisPort > 65535
  ) {
    throw new Error('audit target identity is invalid');
  }

  const resultDirectory = path.resolve(repositoryRoot, config.resultDir);
  if (
    path.dirname(resultDirectory) !== path.join(repositoryRoot, 'k6', 'results')
  ) {
    throw new Error('audit result path is invalid');
  }
  const metadata = JSON.parse(
    await readFile(path.join(resultDirectory, 'metadata.json'), 'utf8'),
  );
  const summary = JSON.parse(
    await readFile(path.join(resultDirectory, '.summary.json.tmp'), 'utf8'),
  );
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
    enableOfflineQueue: false,
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
      throw new Error('audit environment identity does not match');
    }

    const base = `${config.redisKeyPrefix}run:${config.runId}:`;
    const fixtureText = await redis.get(`${base}fixture`);
    if (!fixtureText) throw new Error('fixture boundary is missing');
    const fixtureSource = JSON.parse(fixtureText);
    if (
      fixtureSource.runId !== config.runId ||
      !fixtureSource.performanceId ||
      !Array.isArray(fixtureSource.userIds) ||
      !Array.isArray(fixtureSource.seatIds)
    ) {
      throw new Error('fixture boundary is invalid');
    }

    const timeoutMs = integerEnvironment(
      'AUDIT_TIMEOUT_MS',
      30000,
      1000,
      120000,
    );
    const stableMs = integerEnvironment(
      'AUDIT_STABLE_MS',
      1000,
      500,
      timeoutMs,
    );
    const pollMs = integerEnvironment('AUDIT_POLL_MS', 100, 50, 1000);
    const started = Date.now();
    let stableSince = null;
    let stableSignature = null;
    let finalSample = null;

    while (Date.now() - started <= timeoutMs) {
      const [state, counters, queues] = await Promise.all([
        redis.hgetall(`${base}state`),
        redis.hgetall(`${base}counters`),
        readQueueState(redis),
      ]);
      finalSample = {
        producerState: state.producer || 'UNKNOWN',
        cacheProfileState: state.cache_profile || null,
        counters: numericHash(counters),
        ...queues,
        workerInFlight: Number(counters.worker_in_flight || 0),
      };
      const signature = drainSignature(finalSample);
      if (isDrainCandidate(finalSample)) {
        if (signature !== stableSignature) {
          stableSignature = signature;
          stableSince = Date.now();
        } else if (stableSince && Date.now() - stableSince >= stableMs) {
          break;
        }
      } else {
        stableSince = null;
        stableSignature = null;
      }
      await sleep(pollMs);
    }
    if (!finalSample) throw new Error('audit did not collect queue state');
    const timedOut =
      !isDrainCandidate(finalSample) ||
      stableSince === null ||
      Date.now() - stableSince < stableMs;

    const [
      acceptedMappings,
      processedIds,
      failedMappings,
      requestMappings,
      queueMessages,
    ] = await Promise.all([
      redis.hgetall(`${base}accepted`),
      redis.smembers(`${base}processed`),
      redis.hgetall(`${base}failed`),
      redis.hgetall(`${base}requests`),
      Promise.all([
        readStreamPayloads(redis, RESERVATION_STREAM),
        readStreamPayloads(redis, RESERVATION_DLQ_STREAM),
      ]),
    ]);
    const actualRequests = Object.fromEntries(
      Object.entries(requestMappings).map(([requestId, value]) => {
        try {
          return [requestId, JSON.parse(value)];
        } catch {
          return [requestId, null];
        }
      }),
    );
    const foreignQueueMessages = queueMessages
      .flat()
      .reduce(
        (count, raw) => count + countForeignMessages([raw], config.runId),
        0,
      );

    const reservationRows = await pool.query(
      `SELECT r.id, r."seatId", r.status
       FROM "Reservation" r
       JOIN "Seat" s ON s.id = r."seatId"
       WHERE s."performanceId" = $1
       ORDER BY r.id`,
      [fixtureSource.performanceId],
    );
    const seatStatusRows = await pool.query(
      `SELECT status::text, COUNT(*)::int AS count
       FROM "Seat" WHERE "performanceId" = $1
       GROUP BY status ORDER BY status`,
      [fixtureSource.performanceId],
    );
    const seatRows = await pool.query(
      `SELECT id, status::text AS status
       FROM "Seat" WHERE "performanceId" = $1
       ORDER BY id`,
      [fixtureSource.performanceId],
    );
    const reservationStatusRows = await pool.query(
      `SELECT r.status::text, COUNT(*)::int AS count
       FROM "Reservation" r
       JOIN "Seat" s ON s.id = r."seatId"
       WHERE s."performanceId" = $1
       GROUP BY r.status ORDER BY r.status`,
      [fixtureSource.performanceId],
    );
    const redisSeatStatusValues = await redis.mget(
      ...fixtureSource.seatIds.map((seatId) => `seat:${seatId}:status`),
    );

    const metricCount = (name) =>
      Number(summary.metrics?.[name]?.values?.count || 0);
    const capacityRequestCount = metricCount('reservation_requests');
    const capacityFixture =
      config.scenario === 'capacity-vu'
        ? buildCapacityExpectedRequestManifest(
            config.runId,
            capacityRequestCount,
            fixtureSource.userIds,
            fixtureSource.seatIds,
            fixtureSource.capacityProfile,
            fixtureSource.requestManifest?.requestBudget,
          )
        : null;
    const consistencyFixture =
      config.scenario === 'capacity-vu'
        ? capacityFixture
        : fixtureSource.requestManifest
          ? buildExpectedRequestManifest(
              config.runId,
              fixtureSource.requestManifest.totalRequests,
              fixtureSource.userIds,
              fixtureSource.seatIds,
              fixtureSource.requestManifest.assignment,
            )
          : null;
    const expectedAccepted =
      config.scenario === 'capacity-vu'
        ? fixtureSource.capacityProfile === 'unique-seat'
          ? capacityRequestCount
          : Math.min(capacityRequestCount, 1)
        : fixtureSource.expectedAccepted;
    const expectedConflicts =
      config.scenario === 'capacity-vu'
        ? fixtureSource.capacityProfile === 'hot-seat'
          ? Math.max(capacityRequestCount - 1, 0)
          : 0
        : fixtureSource.expectedConflicts;
    const audit = buildConsistencyAudit({
      runId: config.runId,
      testEnvId: config.testEnvId,
      performanceId: fixtureSource.performanceId,
      producerState: finalSample.producerState,
      summaryAccepted: Number(summary.metrics?.accepted?.values?.count || 0),
      summaryConflicts: metricCount('expected_conflict'),
      summaryUnexpectedErrors: metricCount('unexpected_error'),
      summaryTimeouts: metricCount('timeout'),
      summaryIterations:
        config.scenario === 'capacity-vu'
          ? capacityRequestCount
          : metricCount('iterations'),
      summaryFirstAccepted: metricCount('rebooking_first_accepted'),
      summarySecondAccepted: metricCount('rebooking_second_accepted'),
      expectedIterations:
        config.scenario === 'capacity-vu'
          ? capacityRequestCount
          : config.totalIterations,
      scenario: config.scenario,
      expectedAccepted,
      expectedConflicts,
      expectedRequests: consistencyFixture?.requests,
      expectedRequestsPerSeat: consistencyFixture?.requestsPerSeat,
      actualRequests,
      cacheProfile: fixtureSource.cacheProfile,
      cacheProfileState: finalSample.cacheProfileState,
      acceptedMappings,
      processedIds,
      failedMappings,
      counters: finalSample.counters,
      queues: {
        pending: finalSample.pending,
        processing: finalSample.processing,
        retry: finalSample.retry,
        dlq: finalSample.dlq,
      },
      drain: {
        timedOut,
        timeoutMs,
        pollMs,
        stableMs,
        elapsedMs: Date.now() - started,
      },
      foreignQueueMessages,
      db: {
        reservations: reservationRows.rows,
        seatStatusById: Object.fromEntries(
          seatRows.rows.map((seat) => [seat.id, seat.status]),
        ),
        seatStatusDistribution: distribution(seatStatusRows.rows),
        reservationStatusDistribution: distribution(reservationStatusRows.rows),
      },
      redisSeatStatuses: Object.fromEntries(
        fixtureSource.seatIds.map((seatId, index) => [
          seatId,
          redisSeatStatusValues[index],
        ]),
      ),
    });

    const fixtureManifest = {
      schemaVersion: 1,
      runId: config.runId,
      testEnvId: config.testEnvId,
      userIds: [...fixtureSource.userIds].sort(),
      eventIds: [fixtureSource.eventId],
      performanceIds: [fixtureSource.performanceId],
      seatIds: [...fixtureSource.seatIds].sort(),
      requestIds: audit.ids.acceptedRequestIds,
      reservationIds: audit.ids.acceptedReservationIds,
      scenario: fixtureSource.scenario || config.scenario,
      cacheProfile: fixtureSource.cacheProfile || null,
      requestManifest: fixtureSource.requestManifest || null,
      capacityProfile: fixtureSource.capacityProfile || null,
      userBehavior: fixtureSource.userBehavior || null,
      thinkTimeMs: fixtureSource.thinkTimeMs ?? null,
      expectedAccepted: expectedAccepted ?? null,
      expectedConflicts: expectedConflicts ?? null,
      requestsPerSeat:
        config.scenario === 'capacity-vu'
          ? consistencyFixture?.requestsPerSeat || null
          : (fixtureSource.requestsPerSeat ?? null),
      counts: {
        users: fixtureSource.userIds.length,
        events: 1,
        performances: 1,
        seats: fixtureSource.seatIds.length,
        acceptedReservations: audit.ids.acceptedReservationIds.length,
        requestAttempts: Object.keys(actualRequests).length,
      },
    };

    const databaseStats = await pool.query(
      `SELECT numbackends::int AS connections,
              xact_commit::bigint::text AS "transactionsCommitted",
              xact_rollback::bigint::text AS "transactionsRolledBack"
       FROM pg_stat_database WHERE datname = current_database()`,
    );
    const appMetrics = await collectApplicationMetrics(config, resultDirectory);
    const serverMetrics = {
      schemaVersion: 2,
      runId: config.runId,
      window: {
        startedAt: metadata.startedAt,
        endedAt: new Date().toISOString(),
        timezone: 'UTC',
      },
      app: appMetrics,
      database: {
        status: 'available',
        reason: null,
        sourceUri: null,
        sourceType: 'direct_local_snapshot',
        rawQueries: [
          {
            statement:
              'pg_stat_database current database connections and transaction totals',
            timezone: 'UTC',
          },
        ],
        missingMetrics: [
          'query_latency_time_series',
          'lock_wait_duration_time_series',
        ],
        summary: databaseStats.rows[0] || {},
      },
      redis: {
        status: 'available',
        reason: null,
        sourceUri: null,
        sourceType: 'direct_local_snapshot',
        rawQueries: [{ command: 'INFO', timezone: 'UTC' }],
        missingMetrics: ['command_latency_time_series'],
        summary: parseRedisInfo(await redis.info()),
      },
      pm2: {
        status: 'unavailable',
        reason: 'local disposable run does not use PM2',
        sourceUri: null,
        rawQueries: [
          {
            metricNames: [
              'pm2_cpu',
              'pm2_memory',
              'pm2_uptime',
              'pm2_restarts',
              'pm2_loop_delay',
            ],
            timezone: 'UTC',
          },
        ],
        missingMetrics: ['pm2 process metrics'],
      },
    };

    const report = [
      `# k6 Run ${config.runId}`,
      '',
      '## 목표',
      '',
      config.scenario === 'capacity-vu'
        ? `${config.capacityProfile} VU 탐색의 실제 RPS, outcome별 지연, 자원 포화와 최종 ID 정합성을 기록한다.`
        : `${config.scenario} 요청 manifest, 접수 ID와 비동기 처리 후 DB 영속화 ID가 정확히 일치하는지 검증한다.`,
      '',
      '## 조건',
      '',
      `- Test environment: ${config.testEnvId}`,
      `- VU / target RPS / duration: ${config.vus} / ${config.rps ?? 'not set'} / ${config.duration}`,
      `- Cache profile: ${config.cacheProfile}`,
      ...(config.scenario === 'capacity-vu'
        ? [
            `- Capacity profile: ${config.capacityProfile}`,
            `- User behavior / think time: ${config.capacityUserBehavior} / ${config.capacityThinkTime}`,
            `- Request budget: ${config.capacityRequestBudget}`,
          ]
        : []),
      `- Expected accepted / conflict: ${expectedAccepted} / ${expectedConflicts}`,
      `- Performance ID: ${fixtureSource.performanceId}`,
      '',
      '## 핵심 수치',
      '',
      `- Accepted reservations: ${audit.ids.acceptedReservationIds.length}`,
      `- Persisted reservations: ${audit.database.reservationCount}`,
      `- Request attempts: ${audit.requestAudit?.actualCount ?? 'not applicable'}`,
      ...(summary.capacityStages
        ? summary.capacityStages.map(
            (stage) =>
              `- Stage ${stage.stage} (${stage.targetVus} VU) actual RPS: ${stage.actualRps.toFixed(2)}`,
          )
        : []),
      ...(audit.rebooking
        ? [
            `- First / second reservation status: ${audit.rebooking.firstStatus} / ${audit.rebooking.secondStatus}`,
            `- Historical / active reservations: ${audit.rebooking.historyCount} / ${audit.rebooking.activeCount}`,
          ]
        : []),
      `- Drain time: ${audit.drain.elapsedMs}ms`,
      `- Pending / processing / retry / DLQ: ${audit.queues.pending} / ${audit.queues.processing} / ${audit.queues.retry} / ${audit.queues.dlq}`,
      '',
      '## 정합성 결과',
      '',
      `- Verdict: ${audit.consistency.pass ? 'PASS' : 'FAIL'}`,
      `- Reasons: ${audit.consistency.reasons.length ? audit.consistency.reasons.join(', ') : 'none'}`,
      ...(config.scenario === 'capacity-vu'
        ? [
            '- Capacity verdict: exploratory / NOT_APPLICABLE',
            `- SLO threshold observation: ${summary.thresholdPassed ? 'within thresholds' : 'threshold exceeded'}`,
          ]
        : []),
      '',
      '## 한계',
      '',
      appMetrics.valid
        ? '- 애플리케이션 지표는 Run 시작·종료 `/metrics` snapshot의 차이로 기록했다.'
        : '- 애플리케이션 지표가 불완전해 server-metrics의 missing 항목을 확인해야 한다.',
      '- DB·Redis는 종료 시점 snapshot이며 세부 시계열은 아직 수집하지 않는다.',
      config.scenario === 'capacity-vu'
        ? '- 이 탐색 Run은 고정 RPS 회귀 PASS/FAIL이나 지속 가능한 처리량을 입증하지 않는다.'
        : '- 이 Run은 정합성 검증이며 처리량 한계를 입증하지 않는다.',
      '',
      '## 다음 결정',
      '',
      config.scenario === 'capacity-vu'
        ? '- 단계별 실제 RPS, outcome latency, 앱·DB·Redis 지표와 queue drain을 함께 보고 다음 탐색 범위를 결정한다.'
        : audit.consistency.pass
          ? '- ID 감사 기반을 후속 정합성 시나리오에 재사용한다.'
          : '- 후속 부하 단계를 중단하고 실패 ID와 queue 상태를 조사한다.',
      '',
    ].join('\n');

    await Promise.all([
      atomicTempWrite(
        path.join(resultDirectory, '.fixture-manifest.json.tmp'),
        `${JSON.stringify(fixtureManifest, null, 2)}\n`,
      ),
      atomicTempWrite(
        path.join(resultDirectory, '.consistency-audit.json.tmp'),
        `${JSON.stringify(audit, null, 2)}\n`,
      ),
      atomicTempWrite(
        path.join(resultDirectory, '.server-metrics.json.tmp'),
        `${JSON.stringify(serverMetrics, null, 2)}\n`,
      ),
      atomicTempWrite(path.join(resultDirectory, '.report.md.tmp'), report),
    ]);
    process.stdout.write(
      `consistency audit: ${audit.consistency.pass ? 'PASS' : 'FAIL'}\n`,
    );
    process.stdout.write(
      `observability audit: ${appMetrics.valid ? 'PASS' : 'FAIL'}\n`,
    );
    if (!audit.consistency.pass || !appMetrics.valid) process.exitCode = 2;
  } finally {
    await pool.end().catch(() => undefined);
    redis.disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`consistency audit rejected: ${error.message}\n`);
  process.exitCode = 1;
});
