import {
  CAPACITY_PROFILES,
  estimateCapacityRequestBudget,
} from './capacity.js';

export const CONFIG_DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:3000',
  rps: 1,
  expectedAppId: 'fast_pass',
  expectedDbTlsMode: 'disable',
  expectedRedisTlsMode: 'disable',
});

export const SCENARIO_DEFAULTS = Object.freeze({
  smoke: Object.freeze({
    vus: 1,
    duration: '5s',
    userCount: 1,
    seatCount: 5,
    scriptPath: 'k6/scenarios/smoke.js',
  }),
  'consistency-one-seat': Object.freeze({
    vus: 10,
    duration: '60s',
    userCount: 10,
    seatCount: 1,
    scriptPath: 'k6/scenarios/consistency-one-seat.js',
  }),
  'consistency-inventory': Object.freeze({
    vus: 1000,
    duration: '60s',
    userCount: 1000,
    seatCount: 50,
    scriptPath: 'k6/scenarios/consistency-inventory.js',
  }),
  rebooking: Object.freeze({
    vus: 1,
    duration: '30s',
    userCount: 1,
    seatCount: 1,
    scriptPath: 'k6/scenarios/rebooking.js',
  }),
  'capacity-vu': Object.freeze({
    vus: 2000,
    duration: '14m30s',
    userCount: 2000,
    seatCount: 20000,
    scriptPath: 'k6/scenarios/capacity-vu.js',
  }),
});

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const DATABASE_NAME_PATTERN = /^fast_pass_k6_[a-z0-9_]{3,48}$/;
const BUILD_SHA_PATTERN = /^[a-f0-9]{40}$/;
const MIGRATION_ID_PATTERN = /^[0-9]{14}(?:_[A-Za-z0-9_-]{1,64})?$/;
const DURATION_PATTERN = /^([1-9][0-9]*)(ms|s|m|h)$/;
const FORBIDDEN_ENV_PATTERN =
  /(^|[-_.])(prod|production|shared|staging)([-_.]|$)/i;

function normalizeHostname(hostname) {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

export function isLoopbackHostname(hostname) {
  const normalized = normalizeHostname(hostname);
  const ipv4Parts = normalized.split('.');
  const isLoopbackIpv4 =
    ipv4Parts.length === 4 &&
    ipv4Parts.every(
      (part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255,
    ) &&
    Number(ipv4Parts[0]) === 127;
  return normalized === 'localhost' || normalized === '::1' || isLoopbackIpv4;
}

function parseInteger(name, rawValue, defaultValue, minimum, maximum, errors) {
  const source =
    rawValue === undefined || rawValue === '' ? String(defaultValue) : rawValue;
  if (!/^[0-9]+$/.test(source)) {
    errors.push(`${name} must be an integer`);
    return defaultValue;
  }

  const value = Number(source);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    errors.push(`${name} must be between ${minimum} and ${maximum}`);
    return defaultValue;
  }
  return value;
}

function parseNumber(name, rawValue, defaultValue, minimum, maximum, errors) {
  const source =
    rawValue === undefined || rawValue === '' ? String(defaultValue) : rawValue;
  const value = Number(source);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    errors.push(`${name} must be between ${minimum} and ${maximum}`);
    return defaultValue;
  }
  return value;
}

function parseDuration(
  name,
  rawValue,
  defaultValue,
  minimumMs,
  maximumMs,
  errors,
) {
  const value = rawValue || defaultValue;
  const milliseconds = durationToMilliseconds(value);
  if (
    milliseconds === null ||
    milliseconds < minimumMs ||
    milliseconds > maximumMs
  ) {
    errors.push(`${name} must be between ${minimumMs}ms and ${maximumMs}ms`);
    return {
      value: defaultValue,
      milliseconds: durationToMilliseconds(defaultValue),
    };
  }
  return { value, milliseconds };
}

function parseCapacityTargets(rawValue, errors) {
  const rawTargets = (rawValue || '100,500,1000,2000').split(',');
  if (
    rawTargets.length !== 4 ||
    rawTargets.some((value) => !/^[1-9][0-9]*$/.test(value.trim()))
  ) {
    errors.push(
      'CAPACITY_VU_STAGES must contain exactly four positive integers',
    );
    return [100, 500, 1000, 2000];
  }
  const targets = rawTargets.map((value) => Number(value.trim()));
  if (
    targets.some((value) => value > 10000) ||
    targets.some((value, index) => index > 0 && value <= targets[index - 1])
  ) {
    errors.push(
      'CAPACITY_VU_STAGES must be strictly increasing and at most 10000',
    );
    return [100, 500, 1000, 2000];
  }
  return targets;
}

export function durationToMilliseconds(duration) {
  const match = DURATION_PATTERN.exec(duration);
  if (!match) return null;
  const value = Number(match[1]);
  const multipliers = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return value * multipliers[match[2]];
}

function validateSafeIdentifier(name, value, errors) {
  if (!value) {
    errors.push(`${name} is required`);
    return;
  }
  if (!SAFE_ID_PATTERN.test(value) || value.includes('..')) {
    errors.push(`${name} must be a 3-64 character safe identifier`);
  }
}

function parseBaseUrl(rawValue, env, errors) {
  const rawBaseUrl = rawValue || CONFIG_DEFAULTS.baseUrl;
  const match =
    /^(https?):\/\/(\[[0-9A-Fa-f:]+\]|[^\s\/?#:@]+)(?::([0-9]{1,5}))?\/?$/.exec(
      rawBaseUrl,
    );
  if (!match) {
    errors.push('BASE_URL must be a valid absolute URL');
    return {
      baseUrl: CONFIG_DEFAULTS.baseUrl,
      hostname: '127.0.0.1',
      isLocal: true,
    };
  }

  const [, protocol, rawHostname, rawPort] = match;
  if (rawPort && (Number(rawPort) < 1 || Number(rawPort) > 65535)) {
    errors.push('BASE_URL port must be between 1 and 65535');
  }
  const hostname = normalizeHostname(rawHostname);
  const isLocal = isLoopbackHostname(hostname);
  if (!isLocal) {
    if (env.ALLOW_REMOTE_LOAD !== 'true') {
      errors.push('ALLOW_REMOTE_LOAD=true is required for a remote target');
    }
    if (!env.REMOTE_APPROVAL_MANIFEST) {
      errors.push('REMOTE_APPROVAL_MANIFEST is required for a remote target');
    }
    errors.push(
      'remote execution is disabled until the phase 12 approval manifest verifier is implemented',
    );
  }

  return {
    baseUrl: `${protocol.toLowerCase()}://${rawHostname.toLowerCase()}${
      rawPort ? `:${rawPort}` : ''
    }`,
    hostname,
    isLocal,
  };
}

export function loadConfig(
  env = {},
  { requireExecution = false, scenario: scenarioOverride } = {},
) {
  const errors = [];
  const scenario = scenarioOverride || env.SCENARIO || 'smoke';
  const scenarioDefaults = SCENARIO_DEFAULTS[scenario];
  if (!scenarioDefaults) {
    errors.push(
      `SCENARIO must be one of ${Object.keys(SCENARIO_DEFAULTS).join(', ')}`,
    );
  }
  const defaults = scenarioDefaults || SCENARIO_DEFAULTS.smoke;
  const target = parseBaseUrl(env.BASE_URL, env, errors);
  const consistencyScenario = scenario.startsWith('consistency-');
  const rebookingScenario = scenario === 'rebooking';
  const capacityScenario = scenario === 'capacity-vu';
  const capacityProfile = env.CAPACITY_PROFILE || 'unique-seat';
  if (capacityScenario && !CAPACITY_PROFILES.includes(capacityProfile)) {
    errors.push(
      `CAPACITY_PROFILE must be one of ${CAPACITY_PROFILES.join(', ')}`,
    );
  }
  const capacityTargets = capacityScenario
    ? parseCapacityTargets(env.CAPACITY_VU_STAGES, errors)
    : [];
  const capacityRamp = capacityScenario
    ? parseDuration(
        'CAPACITY_RAMP_DURATION',
        env.CAPACITY_RAMP_DURATION,
        '30s',
        1000,
        10 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const capacityHolds = capacityScenario
    ? capacityTargets.map((_, index) =>
        parseDuration(
          `CAPACITY_STAGE_HOLD_${index + 1}`,
          env[`CAPACITY_STAGE_HOLD_${index + 1}`],
          '3m',
          1000,
          60 * 60 * 1000,
          errors,
        ),
      )
    : [];
  const thinkTime = capacityScenario
    ? parseDuration(
        'CAPACITY_THINK_TIME',
        env.CAPACITY_THINK_TIME,
        '60s',
        100,
        5 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const capacityUserBehavior =
    env.CAPACITY_USER_BEHAVIOR || 'reserve-then-think';
  if (
    capacityScenario &&
    !['reserve-then-think', 'think-then-reserve'].includes(capacityUserBehavior)
  ) {
    errors.push(
      'CAPACITY_USER_BEHAVIOR must be reserve-then-think or think-then-reserve',
    );
  }
  const capacityRequiredRequestBudget = capacityScenario
    ? estimateCapacityRequestBudget(
        capacityTargets,
        capacityHolds.map((hold) => hold.milliseconds),
        capacityRamp.milliseconds,
        thinkTime.milliseconds,
      )
    : 0;
  const capacityRequestBudget = capacityScenario
    ? parseInteger(
        'CAPACITY_REQUEST_BUDGET',
        env.CAPACITY_REQUEST_BUDGET,
        Math.max(20000, capacityRequiredRequestBudget),
        1,
        25000,
        errors,
      )
    : 0;
  const vus = parseInteger(
    'VU',
    capacityScenario ? String(Math.max(...capacityTargets)) : env.VU,
    capacityScenario ? Math.max(...capacityTargets) : defaults.vus,
    1,
    consistencyScenario ? 1000 : capacityScenario ? 10000 : 5,
    errors,
  );
  const rps = capacityScenario
    ? null
    : parseInteger('RPS', env.RPS, CONFIG_DEFAULTS.rps, 1, 10000, errors);
  if (capacityScenario && env.RPS !== undefined && env.RPS !== '') {
    errors.push('RPS must not be set for capacity-vu; actual RPS is measured');
  }
  const userCount = parseInteger(
    'USER_COUNT',
    env.USER_COUNT,
    capacityScenario ? vus : defaults.userCount,
    1,
    consistencyScenario ? 1000 : capacityScenario ? 10000 : 5,
    errors,
  );
  const seatCount = parseInteger(
    'SEAT_COUNT',
    env.SEAT_COUNT,
    capacityScenario
      ? capacityProfile === 'unique-seat'
        ? capacityRequestBudget
        : 1
      : defaults.seatCount,
    1,
    capacityScenario ? 25000 : 100,
    errors,
  );
  const capacityDurationMs = capacityScenario
    ? capacityRamp.milliseconds * (capacityTargets.length + 1) +
      capacityHolds.reduce((total, hold) => total + hold.milliseconds, 0)
    : 0;
  const duration = capacityScenario
    ? `${capacityDurationMs}ms`
    : env.DURATION || defaults.duration;
  const durationMs = capacityScenario
    ? capacityDurationMs
    : durationToMilliseconds(duration);
  if (
    !capacityScenario &&
    (durationMs === null || durationMs < 1000 || durationMs > 60000)
  ) {
    errors.push('DURATION must be between 1s and 60s');
  }
  if (consistencyScenario && userCount !== vus) {
    errors.push('USER_COUNT must exactly equal VU for consistency scenarios');
  } else if (!consistencyScenario && userCount < vus) {
    errors.push('USER_COUNT must be greater than or equal to VU for smoke');
  }
  if (scenario === 'smoke' && seatCount < vus) {
    errors.push('SEAT_COUNT must be greater than or equal to VU for smoke');
  }
  if (scenario === 'consistency-one-seat' && seatCount !== 1) {
    errors.push('SEAT_COUNT must equal 1 for consistency-one-seat');
  }
  if (scenario === 'consistency-inventory') {
    if (seatCount > 50) {
      errors.push('SEAT_COUNT must be at most 50 for consistency-inventory');
    }
    if (vus < seatCount || vus % seatCount !== 0) {
      errors.push(
        'VU must be evenly divisible by SEAT_COUNT for consistency-inventory',
      );
    }
  }
  if (rebookingScenario && (vus !== 1 || userCount !== 1 || seatCount !== 1)) {
    errors.push('rebooking requires exactly 1 VU, 1 user, and 1 seat');
  }
  if (capacityScenario) {
    if (vus !== Math.max(...capacityTargets)) {
      errors.push('capacity-vu VU must equal the maximum configured stage');
    }
    if (capacityRequestBudget < capacityRequiredRequestBudget) {
      errors.push(
        `CAPACITY_REQUEST_BUDGET must be at least ${capacityRequiredRequestBudget} for the configured stages and think time`,
      );
    }
    if (
      (capacityProfile === 'unique-seat' &&
        seatCount !== capacityRequestBudget) ||
      (capacityProfile === 'hot-seat' && seatCount !== 1)
    ) {
      errors.push(
        'SEAT_COUNT must equal CAPACITY_REQUEST_BUDGET for unique-seat and 1 for hot-seat',
      );
    }
    if (
      requireExecution &&
      target.isLocal &&
      (vus > 20 ||
        capacityDurationMs > 2 * 60 * 1000 ||
        capacityRequestBudget > 500)
    ) {
      errors.push(
        'local capacity-vu execution is limited to 20 VU, 2m, and 500 requests',
      );
    }
  }
  const cacheProfile = env.CACHE_PROFILE || 'warm';
  if (!['warm', 'cold'].includes(cacheProfile)) {
    errors.push('CACHE_PROFILE must be warm or cold');
  }

  const runId = env.RUN_ID || (requireExecution ? '' : 'inspect-only');
  if (!requireExecution && runId)
    validateSafeIdentifier('RUN_ID', runId, errors);

  const testEnvId = env.TEST_ENV_ID || '';
  const testDatabaseName = env.TEST_DATABASE_NAME || '';
  const testRedisId = env.TEST_REDIS_ID || '';
  const redisKeyPrefix = env.REDIS_KEY_PREFIX || '';
  const expectedBuildSha = env.EXPECTED_BUILD_SHA || '';
  const expectedMigrationId = env.EXPECTED_MIGRATION_ID || '';
  const expectedAppId = env.EXPECTED_APP_ID || CONFIG_DEFAULTS.expectedAppId;
  const expectedDbTlsMode =
    env.EXPECTED_DB_TLS_MODE || CONFIG_DEFAULTS.expectedDbTlsMode;
  const expectedRedisTlsMode =
    env.EXPECTED_REDIS_TLS_MODE || CONFIG_DEFAULTS.expectedRedisTlsMode;
  const expectedTracingEnabled =
    (env.EXPECTED_TRACING_ENABLED || 'false') === 'true';
  if (
    env.EXPECTED_TRACING_ENABLED &&
    !['true', 'false'].includes(env.EXPECTED_TRACING_ENABLED)
  ) {
    errors.push('EXPECTED_TRACING_ENABLED must be true or false');
  }
  const expectedTraceSampleRatio = parseNumber(
    'EXPECTED_OTEL_TRACE_SAMPLE_RATIO',
    env.EXPECTED_OTEL_TRACE_SAMPLE_RATIO,
    0.1,
    0.0001,
    1,
    errors,
  );
  const expectedMinSpanDurationMs = parseInteger(
    'EXPECTED_OTEL_MIN_SPAN_DURATION_MS',
    env.EXPECTED_OTEL_MIN_SPAN_DURATION_MS,
    0,
    0,
    60000,
    errors,
  );

  if (requireExecution) {
    validateSafeIdentifier('RUN_ID', runId, errors);
    validateSafeIdentifier('TEST_ENV_ID', testEnvId, errors);
    validateSafeIdentifier('TEST_REDIS_ID', testRedisId, errors);
    if (env.TEST_ENVIRONMENT !== 'local-disposable') {
      errors.push('TEST_ENVIRONMENT must be local-disposable');
    }
    if (
      [env.TEST_ENVIRONMENT, testEnvId, testDatabaseName, testRedisId].some(
        (value) => FORBIDDEN_ENV_PATTERN.test(value || ''),
      )
    ) {
      errors.push('shared, staging, and production environments are forbidden');
    }
    if (env.ALLOW_TEST_DATA_MUTATION !== 'true') {
      errors.push('ALLOW_TEST_DATA_MUTATION=true is required');
    }

    const normalizedEnvId = testEnvId.toLowerCase().replace(/[.-]/g, '_');
    if (
      !DATABASE_NAME_PATTERN.test(testDatabaseName) ||
      !testDatabaseName.includes(normalizedEnvId)
    ) {
      errors.push(
        'TEST_DATABASE_NAME must be a dedicated fast_pass_k6_<test_env_id> database',
      );
    }
    if (redisKeyPrefix !== `k6:${testEnvId}:`) {
      errors.push('REDIS_KEY_PREFIX must exactly equal k6:<TEST_ENV_ID>:');
    }
    if (!SAFE_ID_PATTERN.test(expectedAppId)) {
      errors.push('EXPECTED_APP_ID must be a safe identifier');
    }
    if (!BUILD_SHA_PATTERN.test(expectedBuildSha)) {
      errors.push(
        'EXPECTED_BUILD_SHA must be a 40 character lowercase Git SHA',
      );
    }
    if (!MIGRATION_ID_PATTERN.test(expectedMigrationId)) {
      errors.push('EXPECTED_MIGRATION_ID must identify an applied migration');
    }
    if (!['disable', 'require'].includes(expectedDbTlsMode)) {
      errors.push('EXPECTED_DB_TLS_MODE must be disable or require');
    }
    if (!['disable', 'require'].includes(expectedRedisTlsMode)) {
      errors.push('EXPECTED_REDIS_TLS_MODE must be disable or require');
    }
    if (
      !env.TEST_PREFLIGHT_TOKEN ||
      !/^[\x21-\x7E]{32,256}$/.test(env.TEST_PREFLIGHT_TOKEN)
    ) {
      errors.push(
        'TEST_PREFLIGHT_TOKEN must be 32-256 printable ASCII characters',
      );
    }
  }

  if (errors.length > 0) {
    throw new Error(`k6 configuration rejected: ${errors.join('; ')}`);
  }

  const totalRequests = capacityScenario ? null : rebookingScenario ? 2 : vus;
  return Object.freeze({
    scenario,
    scriptPath: defaults.scriptPath,
    baseUrl: target.baseUrl,
    hostname: target.hostname,
    isLocal: target.isLocal,
    runId,
    vus,
    rps,
    duration,
    durationMs,
    userCount,
    seatCount,
    cacheProfile,
    executor: capacityScenario ? 'ramping-vus' : 'per-vu-iterations',
    iterationsPerVu: capacityScenario ? null : 1,
    totalIterations: capacityScenario ? null : vus,
    totalRequests,
    requestsPerSeat: capacityScenario ? null : totalRequests / seatCount,
    expectedAccepted: capacityScenario
      ? null
      : rebookingScenario
        ? 2
        : consistencyScenario
          ? seatCount
          : vus,
    expectedConflicts: capacityScenario
      ? null
      : consistencyScenario
        ? vus - seatCount
        : 0,
    capacityProfile: capacityScenario ? capacityProfile : null,
    capacityTargets,
    capacityRampDuration: capacityRamp.value,
    capacityRampDurationMs: capacityRamp.milliseconds,
    capacityStageHolds: capacityHolds.map((hold) => hold.value),
    capacityStageHoldMs: capacityHolds.map((hold) => hold.milliseconds),
    capacityRequestBudget,
    capacityRequiredRequestBudget,
    capacityUserBehavior: capacityScenario ? capacityUserBehavior : null,
    capacityThinkTime: thinkTime.value,
    capacityThinkTimeMs: thinkTime.milliseconds,
    testEnvironment: env.TEST_ENVIRONMENT || '',
    testEnvId,
    testDatabaseName,
    testRedisId,
    redisKeyPrefix,
    expectedAppId,
    expectedBuildSha,
    expectedMigrationId,
    expectedDbTlsMode,
    expectedRedisTlsMode,
    expectedTracingEnabled,
    expectedTraceSampleRatio,
    expectedMinSpanDurationMs,
    allowTestDataMutation: env.ALLOW_TEST_DATA_MUTATION === 'true',
    resultDir: `k6/results/${runId}`,
    summaryTempPath: `k6/results/${runId}/.summary.json.tmp`,
  });
}

export function toPublicConfig(config) {
  return {
    baseUrl: config.baseUrl,
    runId: config.runId,
    scenario: config.scenario,
    scriptPath: config.scriptPath,
    vus: config.vus,
    rps: config.rps,
    duration: config.duration,
    userCount: config.userCount,
    seatCount: config.seatCount,
    cacheProfile: config.cacheProfile,
    executor: config.executor,
    iterationsPerVu: config.iterationsPerVu,
    totalIterations: config.totalIterations,
    totalRequests: config.totalRequests,
    requestsPerSeat: config.requestsPerSeat,
    expectedAccepted: config.expectedAccepted,
    expectedConflicts: config.expectedConflicts,
    capacityProfile: config.capacityProfile,
    capacityTargets: config.capacityTargets,
    capacityRampDuration: config.capacityRampDuration,
    capacityStageHolds: config.capacityStageHolds,
    capacityRequestBudget: config.capacityRequestBudget,
    capacityRequiredRequestBudget: config.capacityRequiredRequestBudget,
    capacityUserBehavior: config.capacityUserBehavior,
    capacityThinkTime: config.capacityThinkTime,
    testEnvironment: config.testEnvironment,
    testEnvId: config.testEnvId,
    testDatabaseName: config.testDatabaseName,
    testRedisId: config.testRedisId,
    redisKeyPrefix: config.redisKeyPrefix,
    expectedAppId: config.expectedAppId,
    expectedBuildSha: config.expectedBuildSha,
    expectedMigrationId: config.expectedMigrationId,
    expectedDbTlsMode: config.expectedDbTlsMode,
    expectedRedisTlsMode: config.expectedRedisTlsMode,
    expectedTracingEnabled: config.expectedTracingEnabled,
    expectedTraceSampleRatio: config.expectedTraceSampleRatio,
    expectedMinSpanDurationMs: config.expectedMinSpanDurationMs,
    resultDir: config.resultDir,
    remoteExecutionEnabled: false,
  };
}
