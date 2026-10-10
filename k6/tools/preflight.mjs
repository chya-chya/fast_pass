#!/usr/bin/env node

import { loadConfig } from '../lib/config.js';

const MAX_RESPONSE_BYTES = 8192;

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match`);
}

async function main() {
  const config = loadConfig(process.env, { requireExecution: true });
  if (!config.isLocal) throw new Error('preflight target is not loopback');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  let response;
  try {
    response = await fetch(`${config.baseUrl}/health/test-environment`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Test-Preflight-Token': process.env.TEST_PREFLIGHT_TOKEN,
      },
      redirect: 'error',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status !== 200)
    throw new Error('health endpoint rejected the environment');
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_RESPONSE_BYTES)
    throw new Error('health response is too large');
  const rawBody = await response.text();
  if (Buffer.byteLength(rawBody) > MAX_RESPONSE_BYTES) {
    throw new Error('health response is too large');
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (_) {
    throw new Error('health response is not valid JSON');
  }

  assertObject(body, 'health response');
  assertObject(body.database, 'database health');
  assertObject(body.redis, 'redis health');
  assertObject(body.observability, 'observability health');
  assertObject(body.authentication, 'authentication health');
  assertEqual(body.appId, config.expectedAppId, 'application identity');
  assertEqual(body.buildSha, config.expectedBuildSha, 'application build');
  assertEqual(body.testEnvId, config.testEnvId, 'test environment identity');
  assertEqual(body.database.connected, true, 'database connection');
  assertEqual(body.database.name, config.testDatabaseName, 'database identity');
  assertEqual(
    body.database.migrationId,
    config.expectedMigrationId,
    'database migration',
  );
  assertEqual(
    body.database.tlsMode,
    config.expectedDbTlsMode,
    'database TLS mode',
  );
  assertEqual(body.redis.connected, true, 'Redis connection');
  assertEqual(body.redis.id, config.testRedisId, 'Redis identity');
  assertEqual(body.redis.keyPrefix, config.redisKeyPrefix, 'Redis key prefix');
  assertEqual(
    body.redis.tlsMode,
    config.expectedRedisTlsMode,
    'Redis TLS mode',
  );
  assertEqual(
    body.observability.tracingEnabled,
    config.expectedTracingEnabled,
    'tracing mode',
  );
  assertEqual(
    body.observability.traceSampleRatio,
    config.expectedTraceSampleRatio,
    'trace sample ratio',
  );
  assertEqual(
    body.observability.minSpanDurationMs,
    config.expectedMinSpanDurationMs,
    'trace duration filter',
  );
  if (config.loadAccessTokenTtlSeconds) {
    assertEqual(
      body.authentication.accessTokenTtlSeconds,
      config.loadAccessTokenTtlSeconds,
      'access token TTL',
    );
  }

  process.stdout.write(
    'preflight verified: disposable environment identities match\n',
  );
}

main().catch((error) => {
  const reason =
    error && error.name === 'AbortError' ? 'request timed out' : error.message;
  process.stderr.write(`preflight rejected: ${reason}\n`);
  process.exitCode = 1;
});
