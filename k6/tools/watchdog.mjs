#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

import { loadConfig } from '../lib/config.js';
import { parsePrometheusSnapshot } from '../lib/prometheus.js';

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');
const MAX_METRICS_BYTES = 2 * 1024 * 1024;

function metricValue(snapshot, name, labels = {}, reducer = 'sum') {
  const values = snapshot.series
    .filter(
      (series) =>
        series.name === name &&
        Object.entries(labels).every(
          ([key, value]) => series.labels[key] === value,
        ),
    )
    .map((series) => series.value);
  if (values.length === 0) return null;
  return reducer === 'max'
    ? Math.max(...values)
    : values.reduce((total, value) => total + value, 0);
}

function redisInfoValue(raw, name) {
  const line = raw
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${name}:`));
  if (!line) return null;
  const value = Number(line.slice(name.length + 1).trim());
  return Number.isFinite(value) ? value : null;
}

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

async function generatorCpuPercent(pid) {
  const result = await execFileAsync('ps', ['-p', String(pid), '-o', '%cpu='], {
    timeout: 2000,
  });
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) ? value : null;
}

async function main() {
  const config = loadConfig(process.env, { requireExecution: true });
  if (!['spike', 'soak'].includes(config.scenario)) {
    throw new Error('watchdog is available only for Spike and Soak');
  }
  const rawPid = process.argv[2];
  if (!rawPid || !/^[1-9][0-9]*$/.test(rawPid)) {
    throw new Error('watchdog requires the k6 process ID');
  }
  const k6Pid = Number(rawPid);
  process.kill(k6Pid, 0);

  const pool = new Pool({
    connectionString: process.env.AUDIT_DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
  });
  const redis = new Redis({
    host: process.env.AUDIT_REDIS_HOST,
    port: Number(process.env.AUDIT_REDIS_PORT),
    lazyConnect: true,
    connectTimeout: 2000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  await redis.connect();

  const outputPath = path.join(
    repositoryRoot,
    config.resultDir,
    '.watchdog.json.tmp',
  );
  const state = {
    schemaVersion: 1,
    runId: config.runId,
    scenario: config.scenario,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'RUNNING',
    abortReason: null,
    sampleCount: 0,
    polling: {
      intervalMs: config.watchdogPollIntervalMs,
      consecutiveViolations: config.watchdogConsecutiveViolations,
    },
    thresholds: {
      unexpectedErrorRate: config.watchdogMaxUnexpectedErrorRate,
      databaseConnectionRatio: config.watchdogMaxDatabaseConnectionRatio,
      eventLoopLagMs: config.watchdogMaxEventLoopLagMs,
      generatorCpuPercent: config.watchdogMaxGeneratorCpuPercent,
      queueDepth: config.watchdogMaxQueueDepth,
      redisEvictions: 0,
    },
    maxima: {
      unexpectedErrorRate: 0,
      databaseConnections: 0,
      databaseConnectionRatio: 0,
      eventLoopLagMs: 0,
      generatorCpuPercent: 0,
      queueDepth: 0,
      rssBytes: 0,
      heapBytes: 0,
    },
    trends: {
      rssFirstBytes: null,
      rssLastBytes: null,
      rssPositiveSteps: 0,
      queueFirstDepth: null,
      queueLastDepth: null,
      queuePositiveSteps: 0,
    },
    processRestarts: 0,
    redisEvictions: 0,
    monitoringFailures: 0,
    monitoringInputs: {
      application: 'direct_metrics',
      database: 'direct_pg_stat_database',
      redis: 'direct_info',
      loadGenerator: 'local_process_cpu',
      alb: 'unavailable_in_local_disposable_environment',
      pm2: 'unavailable_in_local_disposable_environment',
    },
  };
  let stopRequested = false;
  let previousRequests = null;
  let previousUnexpected = null;
  let initialEvictions = null;
  let previousProcessStart = null;
  let previousRssBytes = null;
  let previousQueueDepth = null;
  const consecutive = new Map();

  const finish = async (status, abortReason = null) => {
    if (state.finishedAt) return;
    state.status = status;
    state.abortReason = abortReason;
    state.finishedAt = new Date().toISOString();
    await atomicWrite(outputPath, `${JSON.stringify(state, null, 2)}\n`);
  };

  const requestStop = () => {
    stopRequested = true;
  };
  process.once('SIGTERM', requestStop);
  process.once('SIGINT', requestStop);

  try {
    while (!stopRequested) {
      const sampleStartedAt = Date.now();
      let currentViolations = [];
      try {
        const [response, databaseResult, redisInfo, cpuPercent] =
          await Promise.all([
            fetch(`${config.baseUrl}/metrics`, {
              headers: { Accept: 'text/plain' },
              redirect: 'error',
              signal: AbortSignal.timeout(2000),
            }),
            pool.query(
              `SELECT numbackends::int AS connections,
                      current_setting('max_connections')::int AS maximum
               FROM pg_stat_database WHERE datname = current_database()`,
            ),
            redis.info(),
            generatorCpuPercent(k6Pid),
          ]);
        if (response.status !== 200) throw new Error('metrics rejected');
        const rawMetrics = await response.text();
        if (Buffer.byteLength(rawMetrics) > MAX_METRICS_BYTES) {
          throw new Error('metrics response is too large');
        }
        const snapshot = parsePrometheusSnapshot(rawMetrics);
        const requests = metricValue(snapshot, 'reservation_request_total');
        const unexpected = metricValue(
          snapshot,
          'reservation_request_outcome_total',
          { outcome: 'unexpected_failure' },
        );
        const queueDepth = metricValue(
          snapshot,
          'reservation_queue_depth_messages',
          {},
          'max',
        );
        const eventLoopLagSeconds = metricValue(
          snapshot,
          'nodejs_eventloop_lag_seconds',
          {},
          'max',
        );
        const rssBytes = metricValue(
          snapshot,
          'process_resident_memory_bytes',
          {},
          'sum',
        );
        const heapBytes = metricValue(
          snapshot,
          'nodejs_heap_size_used_bytes',
          {},
          'sum',
        );
        const processStart = metricValue(
          snapshot,
          'process_start_time_seconds',
          {},
          'max',
        );
        const database = databaseResult.rows[0];
        const databaseConnections = Number(database?.connections);
        const databaseMaximum = Number(database?.maximum);
        const databaseConnectionRatio =
          databaseMaximum > 0 ? databaseConnections / databaseMaximum : null;
        const evictions = redisInfoValue(redisInfo, 'evicted_keys');
        if (initialEvictions === null) initialEvictions = evictions;
        state.redisEvictions = Math.max(
          0,
          Number(evictions || 0) - Number(initialEvictions || 0),
        );
        const requestDelta =
          previousRequests === null || requests === null
            ? 0
            : Math.max(0, requests - previousRequests);
        const unexpectedDelta =
          previousUnexpected === null || unexpected === null
            ? 0
            : Math.max(0, unexpected - previousUnexpected);
        const unexpectedErrorRate =
          requestDelta > 0 ? unexpectedDelta / requestDelta : 0;
        previousRequests = requests;
        previousUnexpected = unexpected;
        if (
          previousProcessStart !== null &&
          processStart !== null &&
          processStart !== previousProcessStart
        ) {
          state.processRestarts += 1;
        }
        previousProcessStart = processStart;

        const eventLoopLagMs = Number(eventLoopLagSeconds || 0) * 1000;
        if (state.trends.rssFirstBytes === null) {
          state.trends.rssFirstBytes = rssBytes;
        }
        if (state.trends.queueFirstDepth === null) {
          state.trends.queueFirstDepth = queueDepth;
        }
        if (
          previousRssBytes !== null &&
          rssBytes !== null &&
          rssBytes > previousRssBytes
        ) {
          state.trends.rssPositiveSteps += 1;
        }
        if (
          previousQueueDepth !== null &&
          queueDepth !== null &&
          queueDepth > previousQueueDepth
        ) {
          state.trends.queuePositiveSteps += 1;
        }
        state.trends.rssLastBytes = rssBytes;
        state.trends.queueLastDepth = queueDepth;
        previousRssBytes = rssBytes;
        previousQueueDepth = queueDepth;
        Object.assign(state.maxima, {
          unexpectedErrorRate: Math.max(
            state.maxima.unexpectedErrorRate,
            unexpectedErrorRate,
          ),
          databaseConnections: Math.max(
            state.maxima.databaseConnections,
            databaseConnections || 0,
          ),
          databaseConnectionRatio: Math.max(
            state.maxima.databaseConnectionRatio,
            databaseConnectionRatio || 0,
          ),
          eventLoopLagMs: Math.max(state.maxima.eventLoopLagMs, eventLoopLagMs),
          generatorCpuPercent: Math.max(
            state.maxima.generatorCpuPercent,
            cpuPercent || 0,
          ),
          queueDepth: Math.max(state.maxima.queueDepth, queueDepth || 0),
          rssBytes: Math.max(state.maxima.rssBytes, rssBytes || 0),
          heapBytes: Math.max(state.maxima.heapBytes, heapBytes || 0),
        });
        if (unexpectedErrorRate > config.watchdogMaxUnexpectedErrorRate) {
          currentViolations.push('UNEXPECTED_ERROR_RATE_HIGH');
        }
        if (
          databaseConnectionRatio !== null &&
          databaseConnectionRatio > config.watchdogMaxDatabaseConnectionRatio
        ) {
          currentViolations.push('DATABASE_CONNECTION_LIMIT_NEAR');
        }
        if (eventLoopLagMs > config.watchdogMaxEventLoopLagMs) {
          currentViolations.push('EVENT_LOOP_LAG_HIGH');
        }
        if (cpuPercent > config.watchdogMaxGeneratorCpuPercent) {
          currentViolations.push('LOAD_GENERATOR_CPU_SATURATED');
        }
        if (queueDepth > config.watchdogMaxQueueDepth) {
          currentViolations.push('QUEUE_DEPTH_HIGH');
        }
        if (state.redisEvictions > 0) {
          currentViolations.push('REDIS_EVICTION_OBSERVED');
        }
        if (state.processRestarts > 0) {
          currentViolations.push('APPLICATION_RESTART_OBSERVED');
        }
      } catch {
        state.monitoringFailures += 1;
        currentViolations = ['WATCHDOG_INPUT_UNAVAILABLE'];
      }

      state.sampleCount += 1;
      for (const code of new Set([
        ...consecutive.keys(),
        ...currentViolations,
      ])) {
        consecutive.set(
          code,
          currentViolations.includes(code)
            ? (consecutive.get(code) || 0) + 1
            : 0,
        );
      }
      const abortReason = [...consecutive.entries()].find(
        ([, count]) => count >= config.watchdogConsecutiveViolations,
      )?.[0];
      if (abortReason) {
        await finish('ABORTED', abortReason);
        process.kill(k6Pid, 'SIGINT');
        process.exitCode = 2;
        return;
      }
      const elapsed = Date.now() - sampleStartedAt;
      await sleep(Math.max(0, config.watchdogPollIntervalMs - elapsed));
    }
    await finish('COMPLETED');
  } finally {
    await Promise.allSettled([pool.end(), redis.quit()]);
  }
}

main().catch(async (error) => {
  process.stderr.write(`watchdog rejected: ${error.message}\n`);
  process.exitCode = 1;
});
