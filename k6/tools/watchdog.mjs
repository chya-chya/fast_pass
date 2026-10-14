#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { appendFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import Redis from 'ioredis';

import { loadConfig } from '../lib/config.js';
import {
  evaluateWatchdogViolations,
  updateViolationCounters,
} from '../lib/watchdog-policy.js';
import {
  collectApplicationSnapshot,
  collectPm2Snapshots,
} from './metrics-source.mjs';

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

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
  if (reducer === 'max') return Math.max(...values);
  if (reducer === 'min') return Math.min(...values);
  return values.reduce((total, value) => total + value, 0);
}

function redisInfoValue(raw, name) {
  const line = raw
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${name}:`));
  const value = line ? Number(line.slice(name.length + 1).trim()) : NaN;
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

async function generatorCpuPercent(pid) {
  const result = await execFileAsync('ps', ['-p', String(pid), '-o', '%cpu='], {
    timeout: 2000,
  });
  const value = Number(result.stdout.trim());
  if (!Number.isFinite(value)) throw new Error('generator CPU is unavailable');
  return value;
}

async function awsJson(region, args) {
  const result = await execFileAsync(
    'aws',
    ['--region', region, ...args, '--output', 'json', '--no-cli-pager'],
    { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(result.stdout);
}

function remoteIds(env) {
  const ids = (env.APP_INSTANCE_IDS || '').split(',').filter(Boolean);
  if (
    ids.length !== 7 ||
    new Set(ids).size !== 7 ||
    ids.some((id) => !/^i-[0-9a-f]+$/.test(id))
  ) {
    throw new Error('APP_INSTANCE_IDS must contain seven unique EC2 IDs');
  }
  if (!env.TARGET_GROUP_ARN?.startsWith('arn:aws:elasticloadbalancing:')) {
    throw new Error('TARGET_GROUP_ARN is required');
  }
  return ids;
}

async function collectAwsSample(cache) {
  const ids = remoteIds(process.env);
  const region = process.env.AWS_REGION || 'ap-northeast-2';
  const databaseIdentifier = process.env.DATABASE_IDENTIFIER || '';
  const redisClusterId = process.env.REDIS_CLUSTER_ID || '';
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]{2,62}$/.test(databaseIdentifier) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{2,62}$/.test(redisClusterId)
  ) {
    throw new Error('database and Redis CloudWatch identities are required');
  }
  const targetHealth = await awsJson(region, [
    'elbv2',
    'describe-target-health',
    '--target-group-arn',
    process.env.TARGET_GROUP_ARN,
  ]);
  const targets = targetHealth.TargetHealthDescriptions || [];
  if (targets.length !== 7) throw new Error('ALB target count is not seven');
  const unhealthyTargets = targets.filter(
    (target) => target.TargetHealth?.State !== 'healthy',
  ).length;

  if (!cache.value || Date.now() - cache.collectedAt >= 60_000) {
    const end = new Date();
    const start = new Date(end.getTime() - 10 * 60_000);
    const queries = ids.flatMap((id, index) => [
      {
        Id: `c${index}`,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/EC2',
            MetricName: 'CPUUtilization',
            Dimensions: [{ Name: 'InstanceId', Value: id }],
          },
          Period: 300,
          Stat: 'Average',
        },
        ReturnData: true,
      },
      {
        Id: `b${index}`,
        MetricStat: {
          Metric: {
            Namespace: 'AWS/EC2',
            MetricName: 'CPUCreditBalance',
            Dimensions: [{ Name: 'InstanceId', Value: id }],
          },
          Period: 300,
          Stat: 'Minimum',
        },
        ReturnData: true,
      },
    ]);
    queries.push(
      {
        Id: 'databasecpu',
        MetricStat: {
          Metric: {
            Namespace: 'AWS/RDS',
            MetricName: 'CPUUtilization',
            Dimensions: [
              { Name: 'DBInstanceIdentifier', Value: databaseIdentifier },
            ],
          },
          Period: 300,
          Stat: 'Average',
        },
        ReturnData: true,
      },
      {
        Id: 'rediscpu',
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ElastiCache',
            MetricName: 'EngineCPUUtilization',
            Dimensions: [{ Name: 'CacheClusterId', Value: redisClusterId }],
          },
          Period: 300,
          Stat: 'Average',
        },
        ReturnData: true,
      },
      {
        Id: 'redismemory',
        MetricStat: {
          Metric: {
            Namespace: 'AWS/ElastiCache',
            MetricName: 'DatabaseMemoryUsagePercentage',
            Dimensions: [{ Name: 'CacheClusterId', Value: redisClusterId }],
          },
          Period: 300,
          Stat: 'Maximum',
        },
        ReturnData: true,
      },
    );
    const metrics = await awsJson(region, [
      'cloudwatch',
      'get-metric-data',
      '--metric-data-queries',
      JSON.stringify(queries),
      '--start-time',
      start.toISOString(),
      '--end-time',
      end.toISOString(),
      '--scan-by',
      'TimestampDescending',
    ]);
    const results = metrics.MetricDataResults || [];
    const creditValues = results
      .filter((result) => result.Id.startsWith('b'))
      .map((result) => result.Values?.[0])
      .filter(Number.isFinite);
    const cpuValues = results
      .filter((result) => result.Id.startsWith('c'))
      .map((result) => result.Values?.[0])
      .filter(Number.isFinite);
    const valueFor = (id) =>
      results.find((result) => result.Id === id)?.Values?.[0];
    const databaseCpuPercent = valueFor('databasecpu');
    const redisCpuPercent = valueFor('rediscpu');
    const redisMemoryPercent = valueFor('redismemory');
    if (
      creditValues.length !== 7 ||
      cpuValues.length !== 7 ||
      ![databaseCpuPercent, redisCpuPercent, redisMemoryPercent].every(
        Number.isFinite,
      )
    ) {
      throw new Error('CloudWatch inputs are incomplete');
    }
    cache.value = {
      minimumCpuCreditBalance: Math.min(...creditValues),
      maximumAppCpuPercent: Math.max(...cpuValues),
      databaseCpuPercent,
      redisCpuPercent,
      redisMemoryPercent,
    };
    cache.collectedAt = Date.now();
  }
  return { unhealthyTargets, ...cache.value };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function main() {
  const config = loadConfig(process.env, { requireExecution: true });
  if (config.isLocal && !['spike', 'soak'].includes(config.scenario)) {
    throw new Error('local watchdog is available only for Spike and Soak');
  }
  const preflightOnly = process.argv[2] === '--preflight';
  const rawPid = preflightOnly ? String(process.pid) : process.argv[2];
  if (!/^[1-9][0-9]*$/.test(rawPid || '')) {
    throw new Error('watchdog requires --preflight or the k6 process ID');
  }
  const k6Pid = Number(rawPid);
  process.kill(k6Pid, 0);

  const pool = new Pool({
    connectionString: process.env.AUDIT_DATABASE_URL,
    ssl:
      config.expectedDbTlsMode === 'require'
        ? { rejectUnauthorized: true }
        : false,
    max: 1,
    connectionTimeoutMillis: 2000,
    query_timeout: 2000,
  });
  const redis = new Redis({
    host: process.env.AUDIT_REDIS_HOST,
    port: Number(process.env.AUDIT_REDIS_PORT),
    tls: config.expectedRedisTlsMode === 'require' ? {} : undefined,
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
  const timeseriesPath = path.join(
    repositoryRoot,
    config.resultDir,
    '.server-timeseries.ndjson.tmp',
  );
  const state = {
    schemaVersion: 2,
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
      databaseCpuPercent: config.watchdogMaxDatabaseCpuPercent,
      redisCpuPercent: config.watchdogMaxRedisCpuPercent,
      redisMemoryPercent: config.watchdogMaxRedisMemoryPercent,
      eventLoopLagMs: config.watchdogMaxEventLoopLagMs,
      generatorCpuPercent: config.watchdogMaxGeneratorCpuPercent,
      queueDepth: config.watchdogMaxQueueDepth,
      minimumCpuCreditBalance: config.watchdogMinCpuCreditBalance,
      redisEvictions: 0,
      unhealthyTargets: 0,
      processRestarts: 0,
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
      unhealthyTargets: 0,
      appCpuPercent: 0,
      databaseCpuPercent: 0,
      redisCpuPercent: 0,
      redisMemoryPercent: 0,
    },
    minima: { cpuCreditBalance: null },
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
      application: config.isLocal
        ? 'direct_metrics'
        : 'fourteen_worker_metrics',
      database: 'direct_pg_stat_database',
      redis: 'direct_info',
      loadGenerator: 'local_process_cpu',
      alb: config.isLocal
        ? 'unavailable_in_local_disposable_environment'
        : 'aws_target_health',
      pm2: config.isLocal
        ? 'unavailable_in_local_disposable_environment'
        : 'seven_pm2_exporters',
      cloudwatch: config.isLocal
        ? 'unavailable_in_local_disposable_environment'
        : 'ec2_cpu_and_credits',
    },
  };
  let stopRequested = false;
  let previousRequests = null;
  let previousUnexpected = null;
  let initialEvictions = null;
  let initialPm2Restarts = null;
  let previousRssBytes = null;
  let previousQueueDepth = null;
  let consecutive = {};
  const cloudwatchCache = { value: null, collectedAt: 0 };

  const finish = async (status, abortReason = null) => {
    if (state.finishedAt) return;
    state.status = status;
    state.abortReason = abortReason;
    state.finishedAt = new Date().toISOString();
    await atomicWrite(outputPath, `${JSON.stringify(state, null, 2)}\n`);
  };
  process.once('SIGTERM', () => {
    stopRequested = true;
  });
  process.once('SIGINT', () => {
    stopRequested = true;
  });

  try {
    while (!stopRequested) {
      const sampleStartedAt = Date.now();
      let currentViolations = [];
      try {
        const [
          snapshot,
          databaseResult,
          redisInfo,
          cpuPercent,
          pm2Snapshots,
          awsSample,
        ] = await Promise.all([
          collectApplicationSnapshot(config),
          pool.query(
            `SELECT numbackends::int AS connections,
                    current_setting('max_connections')::int AS maximum
             FROM pg_stat_database WHERE datname = current_database()`,
          ),
          redis.info(),
          generatorCpuPercent(k6Pid),
          config.isLocal ? Promise.resolve([]) : collectPm2Snapshots(),
          config.isLocal
            ? Promise.resolve({
                unhealthyTargets: 0,
                minimumCpuCreditBalance: null,
                maximumAppCpuPercent: 0,
                databaseCpuPercent: null,
                redisCpuPercent: null,
                redisMemoryPercent: null,
              })
            : collectAwsSample(cloudwatchCache),
        ]);
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
        const eventLoopLagMs =
          Number(
            metricValue(snapshot, 'nodejs_eventloop_lag_seconds', {}, 'max') ||
              0,
          ) * 1000;
        const rssBytes = metricValue(snapshot, 'process_resident_memory_bytes');
        const heapBytes = metricValue(snapshot, 'nodejs_heap_size_used_bytes');
        if (
          [requests, unexpected, queueDepth, rssBytes, heapBytes].some(
            (value) => value === null,
          )
        ) {
          throw new Error('required worker metric is missing');
        }
        const databaseConnections = Number(databaseResult.rows[0]?.connections);
        const databaseMaximum = Number(databaseResult.rows[0]?.maximum);
        const databaseConnectionRatio = databaseConnections / databaseMaximum;
        if (!Number.isFinite(databaseConnectionRatio)) {
          throw new Error('database ratio is unavailable');
        }
        const evictions = redisInfoValue(redisInfo, 'evicted_keys');
        if (evictions === null) {
          throw new Error('Redis eviction counter is unavailable');
        }
        if (initialEvictions === null) initialEvictions = evictions;
        state.redisEvictions = Math.max(0, evictions - initialEvictions);

        if (!config.isLocal) {
          const flattenedPm2 = {
            comments: [],
            series: pm2Snapshots.flatMap((item) => item.series),
          };
          const pm2Up = metricValue(flattenedPm2, 'pm2_up', {
            name: 'fast_pass',
          });
          const pm2Restarts = metricValue(flattenedPm2, 'pm2_restarts', {
            name: 'fast_pass',
          });
          if (pm2Up !== 14 || pm2Restarts === null) {
            throw new Error('PM2 worker inventory is incomplete');
          }
          if (initialPm2Restarts === null) initialPm2Restarts = pm2Restarts;
          state.processRestarts = Math.max(0, pm2Restarts - initialPm2Restarts);
        }

        const requestDelta =
          previousRequests === null
            ? 0
            : Math.max(0, requests - previousRequests);
        const unexpectedDelta =
          previousUnexpected === null
            ? 0
            : Math.max(0, unexpected - previousUnexpected);
        const unexpectedErrorRate =
          requestDelta > 0 ? unexpectedDelta / requestDelta : 0;
        previousRequests = requests;
        previousUnexpected = unexpected;
        if (state.trends.rssFirstBytes === null) {
          state.trends.rssFirstBytes = rssBytes;
        }
        if (state.trends.queueFirstDepth === null) {
          state.trends.queueFirstDepth = queueDepth;
        }
        if (previousRssBytes !== null && rssBytes > previousRssBytes) {
          state.trends.rssPositiveSteps += 1;
        }
        if (previousQueueDepth !== null && queueDepth > previousQueueDepth) {
          state.trends.queuePositiveSteps += 1;
        }
        state.trends.rssLastBytes = rssBytes;
        state.trends.queueLastDepth = queueDepth;
        previousRssBytes = rssBytes;
        previousQueueDepth = queueDepth;
        state.maxima.unexpectedErrorRate = Math.max(
          state.maxima.unexpectedErrorRate,
          unexpectedErrorRate,
        );
        state.maxima.databaseConnections = Math.max(
          state.maxima.databaseConnections,
          databaseConnections,
        );
        state.maxima.databaseConnectionRatio = Math.max(
          state.maxima.databaseConnectionRatio,
          databaseConnectionRatio,
        );
        state.maxima.eventLoopLagMs = Math.max(
          state.maxima.eventLoopLagMs,
          eventLoopLagMs,
        );
        state.maxima.generatorCpuPercent = Math.max(
          state.maxima.generatorCpuPercent,
          cpuPercent,
        );
        state.maxima.queueDepth = Math.max(state.maxima.queueDepth, queueDepth);
        state.maxima.rssBytes = Math.max(state.maxima.rssBytes, rssBytes);
        state.maxima.heapBytes = Math.max(state.maxima.heapBytes, heapBytes);
        state.maxima.unhealthyTargets = Math.max(
          state.maxima.unhealthyTargets,
          awsSample.unhealthyTargets,
        );
        state.maxima.appCpuPercent = Math.max(
          state.maxima.appCpuPercent,
          awsSample.maximumAppCpuPercent,
        );
        state.maxima.databaseCpuPercent = Math.max(
          state.maxima.databaseCpuPercent,
          awsSample.databaseCpuPercent || 0,
        );
        state.maxima.redisCpuPercent = Math.max(
          state.maxima.redisCpuPercent,
          awsSample.redisCpuPercent || 0,
        );
        state.maxima.redisMemoryPercent = Math.max(
          state.maxima.redisMemoryPercent,
          awsSample.redisMemoryPercent || 0,
        );
        if (awsSample.minimumCpuCreditBalance !== null) {
          state.minima.cpuCreditBalance =
            state.minima.cpuCreditBalance === null
              ? awsSample.minimumCpuCreditBalance
              : Math.min(
                  state.minima.cpuCreditBalance,
                  awsSample.minimumCpuCreditBalance,
                );
        }
        const sample = {
          at: new Date().toISOString(),
          unexpectedErrorRate,
          databaseConnections,
          databaseConnectionRatio,
          eventLoopLagMs,
          generatorCpuPercent: cpuPercent,
          queueDepth,
          rssBytes,
          heapBytes,
          redisEvictions: state.redisEvictions,
          processRestarts: state.processRestarts,
          unhealthyTargets: awsSample.unhealthyTargets,
          minimumCpuCreditBalance: awsSample.minimumCpuCreditBalance,
          appCpuPercent: awsSample.maximumAppCpuPercent,
          databaseCpuPercent: awsSample.databaseCpuPercent,
          redisCpuPercent: awsSample.redisCpuPercent,
          redisMemoryPercent: awsSample.redisMemoryPercent,
        };
        currentViolations = evaluateWatchdogViolations(
          sample,
          state.thresholds,
        );
        sample.violations = currentViolations;
        if (!preflightOnly) {
          await appendFile(timeseriesPath, `${JSON.stringify(sample)}\n`, {
            mode: 0o600,
          });
        }
      } catch {
        state.monitoringFailures += 1;
        currentViolations = ['WATCHDOG_INPUT_UNAVAILABLE'];
      }

      state.sampleCount += 1;
      if (preflightOnly) {
        if (currentViolations.length > 0) {
          throw new Error(currentViolations.join(','));
        }
        process.stdout.write('watchdog preflight verified\n');
        return;
      }
      const updated = updateViolationCounters(
        consecutive,
        currentViolations,
        config.watchdogConsecutiveViolations,
      );
      consecutive = updated.counts;
      const abortReason = updated.abortReason;
      if (abortReason) {
        await finish('ABORTED', abortReason);
        process.kill(k6Pid, 'SIGINT');
        process.exitCode = 2;
        return;
      }
      await sleep(
        Math.max(
          0,
          config.watchdogPollIntervalMs - (Date.now() - sampleStartedAt),
        ),
      );
    }
    await finish('COMPLETED');
  } finally {
    await Promise.allSettled([pool.end(), redis.quit()]);
  }
}

main().catch((error) => {
  process.stderr.write(`watchdog rejected: ${error.message}\n`);
  process.exitCode = 1;
});
