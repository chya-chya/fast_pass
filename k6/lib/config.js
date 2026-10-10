import {
  CAPACITY_PROFILES,
  estimateCapacityRequestBudget,
} from './capacity.js';
import {
  estimateConfirmationRequestBudget,
  estimateExplorationRequestBudget,
  RPS_CONFIRMATION_PERCENT,
  RPS_TEST_PROFILES,
} from './rps.js';
import {
  applySafetyMargin,
  buildFixtureCapacityPlan,
  estimateSoakRequests,
  estimateSpikeRequestBudget,
  estimateSpikeRequests,
} from './endurance.js';

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
  'capacity-rps': Object.freeze({
    vus: 1000,
    duration: '45s',
    userCount: 1000,
    seatCount: 25000,
    scriptPath: 'k6/scenarios/capacity-rps.js',
  }),
  spike: Object.freeze({
    vus: 1000,
    duration: '5m30s',
    userCount: 1000,
    seatCount: 132000,
    scriptPath: 'k6/scenarios/spike.js',
  }),
  soak: Object.freeze({
    vus: 325,
    duration: '60m',
    userCount: 325,
    seatCount: 1287000,
    scriptPath: 'k6/scenarios/soak.js',
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

function parseRpsTargets(rawValue, errors) {
  const rawTargets = (rawValue || '100,300,500,1000').split(',');
  if (
    rawTargets.length !== 4 ||
    rawTargets.some((value) => !/^[1-9][0-9]*$/.test(value.trim()))
  ) {
    errors.push('RPS_STAGES must contain exactly four positive integers');
    return [100, 300, 500, 1000];
  }
  const targets = rawTargets.map((value) => Number(value.trim()));
  if (
    targets.some((value) => value > 10000) ||
    targets.some((value, index) => index > 0 && value <= targets[index - 1])
  ) {
    errors.push('RPS_STAGES must be strictly increasing and at most 10000');
    return [100, 300, 500, 1000];
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
  const capacityVuScenario = scenario === 'capacity-vu';
  const capacityRpsScenario = scenario === 'capacity-rps';
  const capacityScenario = capacityVuScenario || capacityRpsScenario;
  const spikeScenario = scenario === 'spike';
  const soakScenario = scenario === 'soak';
  const longRunScenario = spikeScenario || soakScenario;
  const capacityProfile = env.CAPACITY_PROFILE || 'unique-seat';
  if (capacityScenario && !CAPACITY_PROFILES.includes(capacityProfile)) {
    errors.push(
      `CAPACITY_PROFILE must be one of ${CAPACITY_PROFILES.join(', ')}`,
    );
  }
  const capacityTargets = capacityVuScenario
    ? parseCapacityTargets(env.CAPACITY_VU_STAGES, errors)
    : [];
  const capacityRamp = capacityVuScenario
    ? parseDuration(
        'CAPACITY_RAMP_DURATION',
        env.CAPACITY_RAMP_DURATION,
        '30s',
        1000,
        10 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const capacityHolds = capacityVuScenario
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
  const thinkTime = capacityVuScenario
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
    capacityVuScenario &&
    !['reserve-then-think', 'think-then-reserve'].includes(capacityUserBehavior)
  ) {
    errors.push(
      'CAPACITY_USER_BEHAVIOR must be reserve-then-think or think-then-reserve',
    );
  }
  const capacityRequiredRequestBudget = capacityVuScenario
    ? estimateCapacityRequestBudget(
        capacityTargets,
        capacityHolds.map((hold) => hold.milliseconds),
        capacityRamp.milliseconds,
        thinkTime.milliseconds,
      )
    : 0;
  const capacityRequestBudget = capacityVuScenario
    ? parseInteger(
        'CAPACITY_REQUEST_BUDGET',
        env.CAPACITY_REQUEST_BUDGET,
        Math.max(20000, capacityRequiredRequestBudget),
        1,
        25000,
        errors,
      )
    : 0;
  const rpsTestProfile = env.RPS_TEST_PROFILE || 'explore';
  if (capacityRpsScenario && !RPS_TEST_PROFILES.includes(rpsTestProfile)) {
    errors.push(
      `RPS_TEST_PROFILE must be one of ${RPS_TEST_PROFILES.join(', ')}`,
    );
  }
  const rpsTimeUnit = env.RPS_TIME_UNIT || '1s';
  if (capacityRpsScenario && rpsTimeUnit !== '1s') {
    errors.push('RPS_TIME_UNIT must equal 1s');
  }
  const rpsTargets = capacityRpsScenario
    ? parseRpsTargets(env.RPS_STAGES, errors)
    : [];
  const rpsRamp = capacityRpsScenario
    ? parseDuration(
        'RPS_RAMP_DURATION',
        env.RPS_RAMP_DURATION,
        '5s',
        1000,
        10 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const rpsHolds = capacityRpsScenario
    ? rpsTargets.map((_, index) =>
        parseDuration(
          `RPS_STAGE_HOLD_${index + 1}`,
          env[`RPS_STAGE_HOLD_${index + 1}`],
          '5s',
          1000,
          60 * 60 * 1000,
          errors,
        ),
      )
    : [];
  const rpsConfirmationDuration = capacityRpsScenario
    ? parseDuration(
        'RPS_DURATION',
        env.RPS_DURATION,
        '30s',
        1000,
        60 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const rpsBaseRate = capacityRpsScenario
    ? parseInteger('RPS_RATE', env.RPS_RATE, 500, 1, 10000, errors)
    : 0;
  const rpsConfirmationPercent = capacityRpsScenario
    ? RPS_CONFIRMATION_PERCENT[rpsTestProfile] || null
    : null;
  const rpsRate = capacityRpsScenario
    ? rpsTestProfile === 'explore'
      ? null
      : Math.max(1, Math.ceil((rpsBaseRate * rpsConfirmationPercent) / 100))
    : null;
  const rpsMaxRate = capacityRpsScenario
    ? rpsTestProfile === 'explore'
      ? Math.max(...rpsTargets)
      : rpsRate
    : 0;
  const rpsPreAllocatedVus = capacityRpsScenario
    ? parseInteger(
        'RPS_PRE_ALLOCATED_VUS',
        env.RPS_PRE_ALLOCATED_VUS,
        Math.max(1, Math.ceil(rpsMaxRate / 2)),
        1,
        10000,
        errors,
      )
    : 0;
  const rpsMaxVus = capacityRpsScenario
    ? parseInteger(
        'RPS_MAX_VUS',
        env.RPS_MAX_VUS,
        Math.max(rpsMaxRate, rpsPreAllocatedVus),
        1,
        10000,
        errors,
      )
    : 0;
  const rpsLoadDurationMs = capacityRpsScenario
    ? rpsTestProfile === 'explore'
      ? rpsRamp.milliseconds * (rpsTargets.length + 1) +
        rpsHolds.reduce((total, hold) => total + hold.milliseconds, 0)
      : rpsConfirmationDuration.milliseconds
    : 0;
  const rpsRequiredRequestBudget = capacityRpsScenario
    ? rpsTestProfile === 'explore'
      ? estimateExplorationRequestBudget(
          rpsTargets,
          rpsHolds.map((hold) => hold.milliseconds),
          rpsRamp.milliseconds,
        )
      : estimateConfirmationRequestBudget(rpsRate, rpsLoadDurationMs)
    : 0;
  const rpsRequestBudget = capacityRpsScenario
    ? parseInteger(
        'RPS_REQUEST_BUDGET',
        env.RPS_REQUEST_BUDGET,
        Math.max(
          rpsTestProfile === 'explore' ? 25000 : 20000,
          rpsRequiredRequestBudget,
        ),
        1,
        25000,
        errors,
      )
    : 0;
  const loadTestReduced = longRunScenario && env.LOAD_TEST_REDUCED === 'true';
  if (
    longRunScenario &&
    env.LOAD_TEST_REDUCED !== undefined &&
    !['true', 'false'].includes(env.LOAD_TEST_REDUCED)
  ) {
    errors.push('LOAD_TEST_REDUCED must be true or false');
  }
  const loadTimeUnit = longRunScenario ? env.LOAD_TIME_UNIT || '1s' : null;
  if (longRunScenario && loadTimeUnit !== '1s') {
    errors.push('LOAD_TIME_UNIT must equal 1s');
  }
  const spikeBaselineRps = spikeScenario
    ? parseInteger(
        'SPIKE_BASELINE_RPS',
        env.SPIKE_BASELINE_RPS,
        300,
        1,
        10000,
        errors,
      )
    : 0;
  const spikePeakRps = spikeScenario
    ? parseInteger('SPIKE_PEAK_RPS', env.SPIKE_PEAK_RPS, 1000, 1, 10000, errors)
    : 0;
  if (spikeScenario && spikePeakRps <= spikeBaselineRps) {
    errors.push('SPIKE_PEAK_RPS must be greater than SPIKE_BASELINE_RPS');
  }
  const spikeBaselineDuration = spikeScenario
    ? parseDuration(
        'SPIKE_BASELINE_DURATION',
        env.SPIKE_BASELINE_DURATION,
        '2m',
        1000,
        60 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const spikePeakDuration = spikeScenario
    ? parseDuration(
        'SPIKE_PEAK_DURATION',
        env.SPIKE_PEAK_DURATION,
        '30s',
        1000,
        10 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const spikeRecoveryDuration = spikeScenario
    ? parseDuration(
        'SPIKE_RECOVERY_DURATION',
        env.SPIKE_RECOVERY_DURATION,
        '3m',
        1000,
        60 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const spikeRecoveryMaxLatencyRatio = spikeScenario
    ? parseNumber(
        'SPIKE_RECOVERY_MAX_LATENCY_RATIO',
        env.SPIKE_RECOVERY_MAX_LATENCY_RATIO,
        2,
        1,
        10,
        errors,
      )
    : 0;
  const confirmedSustainableRps = soakScenario
    ? parseInteger(
        'CONFIRMED_SUSTAINABLE_RPS',
        env.CONFIRMED_SUSTAINABLE_RPS,
        500,
        1,
        10000,
        errors,
      )
    : 0;
  const confirmedCapacityRunId = soakScenario
    ? env.CONFIRMED_CAPACITY_RUN_ID || ''
    : null;
  const soakRatePercent = soakScenario
    ? parseInteger(
        'SOAK_RATE_PERCENT',
        env.SOAK_RATE_PERCENT,
        65,
        60,
        70,
        errors,
      )
    : 0;
  const soakRps = soakScenario
    ? Math.max(1, Math.ceil((confirmedSustainableRps * soakRatePercent) / 100))
    : 0;
  const soakDuration = soakScenario
    ? parseDuration(
        'SOAK_DURATION',
        env.SOAK_DURATION,
        '60m',
        1000,
        24 * 60 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  if (
    soakScenario &&
    soakDuration.milliseconds < 60 * 60 * 1000 &&
    !loadTestReduced
  ) {
    errors.push(
      'SOAK_DURATION must be at least 60m unless reduced mode is explicit',
    );
  }
  const loadDurationMs = spikeScenario
    ? spikeBaselineDuration.milliseconds +
      spikePeakDuration.milliseconds +
      spikeRecoveryDuration.milliseconds
    : soakScenario
      ? soakDuration.milliseconds
      : 0;
  const loadMaxRate = spikeScenario ? spikePeakRps : soakScenario ? soakRps : 0;
  const loadPreAllocatedVus = longRunScenario
    ? parseInteger(
        'LOAD_PRE_ALLOCATED_VUS',
        env.LOAD_PRE_ALLOCATED_VUS,
        Math.max(1, Math.ceil(loadMaxRate / 2)),
        1,
        10000,
        errors,
      )
    : 0;
  const loadMaxVus = longRunScenario
    ? parseInteger(
        'LOAD_MAX_VUS',
        env.LOAD_MAX_VUS,
        Math.max(loadMaxRate, loadPreAllocatedVus),
        1,
        10000,
        errors,
      )
    : 0;
  const loadScheduledRequests = spikeScenario
    ? estimateSpikeRequests({
        baselineRps: spikeBaselineRps,
        peakRps: spikePeakRps,
        baselineDurationMs: spikeBaselineDuration.milliseconds,
        peakDurationMs: spikePeakDuration.milliseconds,
        recoveryDurationMs: spikeRecoveryDuration.milliseconds,
      })
    : soakScenario
      ? estimateSoakRequests(soakRps, soakDuration.milliseconds)
      : 0;
  const fixtureSafetyPercent = longRunScenario
    ? parseInteger(
        'FIXTURE_SAFETY_PERCENT',
        env.FIXTURE_SAFETY_PERCENT,
        110,
        100,
        200,
        errors,
      )
    : 0;
  const loadRequiredRequestBudget = longRunScenario
    ? spikeScenario
      ? estimateSpikeRequestBudget({
          baselineRps: spikeBaselineRps,
          peakRps: spikePeakRps,
          baselineDurationMs: spikeBaselineDuration.milliseconds,
          peakDurationMs: spikePeakDuration.milliseconds,
          recoveryDurationMs: spikeRecoveryDuration.milliseconds,
          safetyPercent: fixtureSafetyPercent,
        })
      : applySafetyMargin(loadScheduledRequests, fixtureSafetyPercent)
    : 0;
  const loadRequestBudget = longRunScenario
    ? parseInteger(
        'LOAD_REQUEST_BUDGET',
        env.LOAD_REQUEST_BUDGET,
        loadRequiredRequestBudget,
        1,
        100000000,
        errors,
      )
    : 0;
  const fixtureSeedMode = longRunScenario
    ? env.FIXTURE_SEED_MODE || 'chunked-bulk'
    : null;
  if (
    longRunScenario &&
    !['api-array', 'chunked-bulk'].includes(fixtureSeedMode)
  ) {
    errors.push('FIXTURE_SEED_MODE must be api-array or chunked-bulk');
  }
  const fixtureSeedChunkSize = longRunScenario
    ? parseInteger(
        'FIXTURE_SEED_CHUNK_SIZE',
        env.FIXTURE_SEED_CHUNK_SIZE,
        1000,
        100,
        10000,
        errors,
      )
    : 0;
  const fixtureMaxUsers = longRunScenario
    ? parseInteger(
        'FIXTURE_MAX_USERS',
        env.FIXTURE_MAX_USERS,
        10000,
        1,
        100000,
        errors,
      )
    : 0;
  const fixtureMaxSeats = longRunScenario
    ? parseInteger(
        'FIXTURE_MAX_SEATS',
        env.FIXTURE_MAX_SEATS,
        2000000,
        1,
        100000000,
        errors,
      )
    : 0;
  const fixtureMaxDatabaseRows = longRunScenario
    ? parseInteger(
        'FIXTURE_MAX_DATABASE_ROWS',
        env.FIXTURE_MAX_DATABASE_ROWS,
        5000000,
        1,
        200000000,
        errors,
      )
    : 0;
  const fixtureMaxDatabaseBytes = longRunScenario
    ? parseInteger(
        'FIXTURE_MAX_DATABASE_BYTES',
        env.FIXTURE_MAX_DATABASE_BYTES,
        2147483648,
        1,
        Number.MAX_SAFE_INTEGER,
        errors,
      )
    : 0;
  const fixtureMaxRedisBytes = longRunScenario
    ? parseInteger(
        'FIXTURE_MAX_REDIS_BYTES',
        env.FIXTURE_MAX_REDIS_BYTES,
        1073741824,
        1,
        Number.MAX_SAFE_INTEGER,
        errors,
      )
    : 0;
  const fixtureMaxStorageBytes = longRunScenario
    ? parseInteger(
        'FIXTURE_MAX_STORAGE_BYTES',
        env.FIXTURE_MAX_STORAGE_BYTES,
        2147483648,
        1,
        Number.MAX_SAFE_INTEGER,
        errors,
      )
    : 0;
  const fixtureDatabaseBytesPerRequest = longRunScenario
    ? parseInteger(
        'FIXTURE_DATABASE_BYTES_PER_REQUEST',
        env.FIXTURE_DATABASE_BYTES_PER_REQUEST,
        512,
        1,
        1048576,
        errors,
      )
    : 0;
  const fixtureRedisBytesPerRequest = longRunScenario
    ? parseInteger(
        'FIXTURE_REDIS_BYTES_PER_REQUEST',
        env.FIXTURE_REDIS_BYTES_PER_REQUEST,
        256,
        1,
        1048576,
        errors,
      )
    : 0;
  const fixtureSeedRowsPerSecond = longRunScenario
    ? parseInteger(
        'FIXTURE_SEED_ROWS_PER_SECOND',
        env.FIXTURE_SEED_ROWS_PER_SECOND,
        5000,
        1,
        1000000,
        errors,
      )
    : 0;
  const fixtureCleanupRowsPerSecond = longRunScenario
    ? parseInteger(
        'FIXTURE_CLEANUP_ROWS_PER_SECOND',
        env.FIXTURE_CLEANUP_ROWS_PER_SECOND,
        5000,
        1,
        1000000,
        errors,
      )
    : 0;
  const loadSetupAllowance = longRunScenario
    ? parseDuration(
        'LOAD_SETUP_ALLOWANCE',
        env.LOAD_SETUP_ALLOWANCE,
        '30m',
        1000,
        24 * 60 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const loadDrainAllowance = longRunScenario
    ? parseDuration(
        'LOAD_DRAIN_ALLOWANCE',
        env.LOAD_DRAIN_ALLOWANCE,
        '2m',
        1000,
        60 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const loadAuditAllowance = longRunScenario
    ? parseDuration(
        'LOAD_AUDIT_ALLOWANCE',
        env.LOAD_AUDIT_ALLOWANCE,
        '5m',
        1000,
        60 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const loadTokenSafety = longRunScenario
    ? parseDuration(
        'LOAD_TOKEN_SAFETY',
        env.LOAD_TOKEN_SAFETY,
        '5m',
        1000,
        60 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const loadAccessTokenTtl = longRunScenario
    ? parseDuration(
        'LOAD_ACCESS_TOKEN_TTL',
        env.LOAD_ACCESS_TOKEN_TTL,
        '2h',
        60 * 1000,
        24 * 60 * 60 * 1000,
        errors,
      )
    : { value: null, milliseconds: 0 };
  const loadRequiredTokenTtlMs = longRunScenario
    ? loadSetupAllowance.milliseconds +
      loadDurationMs +
      loadDrainAllowance.milliseconds +
      loadAuditAllowance.milliseconds +
      loadTokenSafety.milliseconds
    : 0;
  const watchdogPollIntervalMs = longRunScenario
    ? parseInteger(
        'WATCHDOG_POLL_INTERVAL_MS',
        env.WATCHDOG_POLL_INTERVAL_MS,
        2000,
        250,
        60000,
        errors,
      )
    : 0;
  const watchdogConsecutiveViolations = longRunScenario
    ? parseInteger(
        'WATCHDOG_CONSECUTIVE_VIOLATIONS',
        env.WATCHDOG_CONSECUTIVE_VIOLATIONS,
        3,
        1,
        20,
        errors,
      )
    : 0;
  const watchdogMaxUnexpectedErrorRate = longRunScenario
    ? parseNumber(
        'WATCHDOG_MAX_UNEXPECTED_ERROR_RATE',
        env.WATCHDOG_MAX_UNEXPECTED_ERROR_RATE,
        0.001,
        0,
        1,
        errors,
      )
    : 0;
  const watchdogMaxDatabaseConnectionRatio = longRunScenario
    ? parseNumber(
        'WATCHDOG_MAX_DATABASE_CONNECTION_RATIO',
        env.WATCHDOG_MAX_DATABASE_CONNECTION_RATIO,
        0.85,
        0.1,
        1,
        errors,
      )
    : 0;
  const watchdogMaxEventLoopLagMs = longRunScenario
    ? parseInteger(
        'WATCHDOG_MAX_EVENT_LOOP_LAG_MS',
        env.WATCHDOG_MAX_EVENT_LOOP_LAG_MS,
        200,
        1,
        60000,
        errors,
      )
    : 0;
  const watchdogMaxGeneratorCpuPercent = longRunScenario
    ? parseNumber(
        'WATCHDOG_MAX_GENERATOR_CPU_PERCENT',
        env.WATCHDOG_MAX_GENERATOR_CPU_PERCENT,
        90,
        1,
        100,
        errors,
      )
    : 0;
  const watchdogMaxQueueDepth = longRunScenario
    ? parseInteger(
        'WATCHDOG_MAX_QUEUE_DEPTH',
        env.WATCHDOG_MAX_QUEUE_DEPTH,
        10000,
        0,
        100000000,
        errors,
      )
    : 0;
  const vus = parseInteger(
    'VU',
    capacityVuScenario
      ? String(Math.max(...capacityTargets))
      : capacityRpsScenario
        ? String(rpsMaxVus)
        : longRunScenario
          ? String(loadMaxVus)
          : env.VU,
    capacityVuScenario
      ? Math.max(...capacityTargets)
      : capacityRpsScenario
        ? rpsMaxVus
        : longRunScenario
          ? loadMaxVus
          : defaults.vus,
    1,
    consistencyScenario || longRunScenario
      ? 10000
      : capacityScenario
        ? 10000
        : 5,
    errors,
  );
  const rps = capacityVuScenario
    ? null
    : capacityRpsScenario
      ? rpsMaxRate
      : longRunScenario
        ? loadMaxRate
        : parseInteger('RPS', env.RPS, CONFIG_DEFAULTS.rps, 1, 10000, errors);
  if (
    (capacityScenario || longRunScenario) &&
    env.RPS !== undefined &&
    env.RPS !== ''
  ) {
    errors.push(
      'RPS must not be set for capacity or long-run scenarios; use the profile-specific settings',
    );
  }
  const userCount = parseInteger(
    'USER_COUNT',
    env.USER_COUNT,
    capacityScenario || longRunScenario ? vus : defaults.userCount,
    1,
    consistencyScenario
      ? 1000
      : capacityScenario || longRunScenario
        ? 10000
        : 5,
    errors,
  );
  const seatCount = parseInteger(
    'SEAT_COUNT',
    env.SEAT_COUNT,
    capacityScenario
      ? capacityProfile === 'unique-seat'
        ? capacityVuScenario
          ? capacityRequestBudget
          : rpsRequestBudget
        : 1
      : longRunScenario
        ? loadRequestBudget
        : defaults.seatCount,
    1,
    longRunScenario ? 100000000 : capacityScenario ? 25000 : 100,
    errors,
  );
  const fixtureCapacityPlan = longRunScenario
    ? buildFixtureCapacityPlan({
        requestBudget: loadRequestBudget,
        userCount,
        databaseBytesPerRequest: fixtureDatabaseBytesPerRequest,
        redisBytesPerRequest: fixtureRedisBytesPerRequest,
        seedRowsPerSecond: fixtureSeedRowsPerSecond,
        cleanupRowsPerSecond: fixtureCleanupRowsPerSecond,
      })
    : null;
  const capacityDurationMs = capacityVuScenario
    ? capacityRamp.milliseconds * (capacityTargets.length + 1) +
      capacityHolds.reduce((total, hold) => total + hold.milliseconds, 0)
    : 0;
  const duration = capacityVuScenario
    ? `${capacityDurationMs}ms`
    : capacityRpsScenario
      ? `${rpsLoadDurationMs}ms`
      : longRunScenario
        ? `${loadDurationMs}ms`
        : env.DURATION || defaults.duration;
  const durationMs = capacityVuScenario
    ? capacityDurationMs
    : capacityRpsScenario
      ? rpsLoadDurationMs
      : longRunScenario
        ? loadDurationMs
        : durationToMilliseconds(duration);
  if (
    !capacityScenario &&
    !longRunScenario &&
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
  if (capacityVuScenario) {
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
  if (capacityRpsScenario) {
    if (rpsPreAllocatedVus > rpsMaxVus) {
      errors.push('RPS_PRE_ALLOCATED_VUS must be at most RPS_MAX_VUS');
    }
    if (rpsRequestBudget < rpsRequiredRequestBudget) {
      errors.push(
        `RPS_REQUEST_BUDGET must be at least ${rpsRequiredRequestBudget} for the configured arrival-rate profile`,
      );
    }
    if (
      (capacityProfile === 'unique-seat' && seatCount !== rpsRequestBudget) ||
      (capacityProfile === 'hot-seat' && seatCount !== 1)
    ) {
      errors.push(
        'SEAT_COUNT must equal RPS_REQUEST_BUDGET for unique-seat and 1 for hot-seat',
      );
    }
    if (
      requireExecution &&
      target.isLocal &&
      (rpsMaxRate > 20 ||
        rpsLoadDurationMs > 60 * 1000 ||
        rpsRequestBudget > 500 ||
        rpsMaxVus > 100)
    ) {
      errors.push(
        'local capacity-rps execution is limited to 20 RPS, 1m, 500 requests, and 100 max VUs',
      );
    }
  }
  if (longRunScenario) {
    if (loadPreAllocatedVus > loadMaxVus) {
      errors.push('LOAD_PRE_ALLOCATED_VUS must be at most LOAD_MAX_VUS');
    }
    if (loadRequestBudget < loadRequiredRequestBudget) {
      errors.push(
        `LOAD_REQUEST_BUDGET must be at least ${loadRequiredRequestBudget} for the configured profile and safety margin`,
      );
    }
    if (seatCount !== loadRequestBudget) {
      errors.push('SEAT_COUNT must equal LOAD_REQUEST_BUDGET');
    }
    if (userCount > fixtureMaxUsers) {
      errors.push('fixture users exceed FIXTURE_MAX_USERS');
    }
    if (fixtureCapacityPlan.seats > fixtureMaxSeats) {
      errors.push('fixture seats exceed FIXTURE_MAX_SEATS');
    }
    if (fixtureCapacityPlan.expectedDatabaseRows > fixtureMaxDatabaseRows) {
      errors.push('fixture rows exceed FIXTURE_MAX_DATABASE_ROWS');
    }
    if (fixtureCapacityPlan.estimatedDatabaseBytes > fixtureMaxDatabaseBytes) {
      errors.push('fixture database bytes exceed FIXTURE_MAX_DATABASE_BYTES');
    }
    if (fixtureCapacityPlan.estimatedRedisBytes > fixtureMaxRedisBytes) {
      errors.push('fixture Redis bytes exceed FIXTURE_MAX_REDIS_BYTES');
    }
    if (fixtureCapacityPlan.estimatedStorageBytes > fixtureMaxStorageBytes) {
      errors.push('fixture storage bytes exceed FIXTURE_MAX_STORAGE_BYTES');
    }
    if (loadAccessTokenTtl.milliseconds < loadRequiredTokenTtlMs) {
      errors.push(
        `LOAD_ACCESS_TOKEN_TTL must cover at least ${loadRequiredTokenTtlMs}ms for setup, load, drain, audit, and safety`,
      );
    }
    if (fixtureSeedMode === 'api-array' && loadRequestBudget > 25000) {
      errors.push(
        'api-array fixture mode is limited to 25000 seats; use an approved chunked-bulk provisioner',
      );
    }
    if (requireExecution && soakScenario) {
      validateSafeIdentifier(
        'CONFIRMED_CAPACITY_RUN_ID',
        confirmedCapacityRunId,
        errors,
      );
    }
    if (requireExecution && target.isLocal) {
      if (!loadTestReduced) {
        errors.push(
          'local Spike/Soak execution requires LOAD_TEST_REDUCED=true',
        );
      }
      if (fixtureSeedMode !== 'api-array') {
        errors.push(
          'local reduced Spike/Soak execution requires FIXTURE_SEED_MODE=api-array',
        );
      }
      if (
        loadMaxRate > 20 ||
        loadDurationMs > 60 * 1000 ||
        loadRequestBudget > 500 ||
        loadMaxVus > 100
      ) {
        errors.push(
          'local reduced Spike/Soak is limited to 20 RPS, 1m, 500 requests, and 100 max VUs',
        );
      }
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

  const totalRequests =
    capacityScenario || longRunScenario ? null : rebookingScenario ? 2 : vus;
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
    executor: capacityVuScenario
      ? 'ramping-vus'
      : capacityRpsScenario
        ? rpsTestProfile === 'explore'
          ? 'ramping-arrival-rate'
          : 'constant-arrival-rate'
        : longRunScenario
          ? 'constant-arrival-rate'
          : 'per-vu-iterations',
    iterationsPerVu: capacityScenario || longRunScenario ? null : 1,
    totalIterations: capacityScenario || longRunScenario ? null : vus,
    totalRequests,
    requestsPerSeat: capacityScenario ? null : totalRequests / seatCount,
    expectedAccepted:
      capacityScenario || longRunScenario
        ? null
        : rebookingScenario
          ? 2
          : consistencyScenario
            ? seatCount
            : vus,
    expectedConflicts:
      capacityScenario || longRunScenario
        ? null
        : consistencyScenario
          ? vus - seatCount
          : 0,
    capacityProfile: capacityScenario
      ? capacityProfile
      : longRunScenario
        ? 'unique-seat'
        : null,
    capacityTargets: capacityVuScenario ? capacityTargets : [],
    capacityRampDuration: capacityRamp.value,
    capacityRampDurationMs: capacityRamp.milliseconds,
    capacityStageHolds: capacityHolds.map((hold) => hold.value),
    capacityStageHoldMs: capacityHolds.map((hold) => hold.milliseconds),
    capacityRequestBudget: capacityVuScenario ? capacityRequestBudget : 0,
    capacityRequiredRequestBudget,
    capacityUserBehavior: capacityVuScenario ? capacityUserBehavior : null,
    capacityThinkTime: capacityVuScenario ? thinkTime.value : null,
    capacityThinkTimeMs: capacityVuScenario ? thinkTime.milliseconds : 0,
    rpsTestProfile: capacityRpsScenario ? rpsTestProfile : null,
    rpsTimeUnit: capacityRpsScenario ? rpsTimeUnit : null,
    rpsTargets,
    rpsRampDuration: rpsRamp.value,
    rpsRampDurationMs: rpsRamp.milliseconds,
    rpsStageHolds: rpsHolds.map((hold) => hold.value),
    rpsStageHoldMs: rpsHolds.map((hold) => hold.milliseconds),
    rpsConfirmationDuration: rpsConfirmationDuration.value,
    rpsConfirmationPercent,
    rpsBaseRate,
    rpsRate,
    rpsMaxRate,
    rpsPreAllocatedVus,
    rpsMaxVus,
    rpsLoadDurationMs,
    rpsRequestBudget,
    rpsRequiredRequestBudget,
    loadTestReduced,
    loadTimeUnit,
    loadDurationMs,
    loadMaxRate,
    loadPreAllocatedVus,
    loadMaxVus,
    loadScheduledRequests,
    loadRequiredRequestBudget,
    loadRequestBudget,
    spikeBaselineRps,
    spikePeakRps,
    spikeBaselineDuration: spikeBaselineDuration.value,
    spikeBaselineDurationMs: spikeBaselineDuration.milliseconds,
    spikePeakDuration: spikePeakDuration.value,
    spikePeakDurationMs: spikePeakDuration.milliseconds,
    spikeRecoveryDuration: spikeRecoveryDuration.value,
    spikeRecoveryDurationMs: spikeRecoveryDuration.milliseconds,
    spikeRecoveryMaxLatencyRatio,
    confirmedSustainableRps,
    confirmedCapacityRunId,
    soakRatePercent,
    soakRps,
    soakDuration: soakDuration.value,
    soakDurationMs: soakDuration.milliseconds,
    fixtureSafetyPercent,
    fixtureSeedMode,
    fixtureSeedChunkSize,
    fixtureMaxUsers,
    fixtureMaxSeats,
    fixtureMaxDatabaseRows,
    fixtureMaxDatabaseBytes,
    fixtureMaxRedisBytes,
    fixtureMaxStorageBytes,
    fixtureDatabaseBytesPerRequest,
    fixtureRedisBytesPerRequest,
    fixtureSeedRowsPerSecond,
    fixtureCleanupRowsPerSecond,
    fixtureCapacityPlan,
    loadSetupAllowance: loadSetupAllowance.value,
    loadDrainAllowance: loadDrainAllowance.value,
    loadAuditAllowance: loadAuditAllowance.value,
    loadTokenSafety: loadTokenSafety.value,
    loadAccessTokenTtl: loadAccessTokenTtl.value,
    loadAccessTokenTtlSeconds: loadAccessTokenTtl.milliseconds / 1000,
    loadRequiredTokenTtlMs,
    watchdogPollIntervalMs,
    watchdogConsecutiveViolations,
    watchdogMaxUnexpectedErrorRate,
    watchdogMaxDatabaseConnectionRatio,
    watchdogMaxEventLoopLagMs,
    watchdogMaxGeneratorCpuPercent,
    watchdogMaxQueueDepth,
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
    rpsTestProfile: config.rpsTestProfile,
    rpsTimeUnit: config.rpsTimeUnit,
    rpsTargets: config.rpsTargets,
    rpsRampDuration: config.rpsRampDuration,
    rpsStageHolds: config.rpsStageHolds,
    rpsConfirmationDuration: config.rpsConfirmationDuration,
    rpsConfirmationPercent: config.rpsConfirmationPercent,
    rpsBaseRate: config.rpsBaseRate,
    rpsRate: config.rpsRate,
    rpsMaxRate: config.rpsMaxRate,
    rpsPreAllocatedVus: config.rpsPreAllocatedVus,
    rpsMaxVus: config.rpsMaxVus,
    rpsLoadDurationMs: config.rpsLoadDurationMs,
    rpsRequestBudget: config.rpsRequestBudget,
    rpsRequiredRequestBudget: config.rpsRequiredRequestBudget,
    loadTestReduced: config.loadTestReduced,
    loadTimeUnit: config.loadTimeUnit,
    loadDurationMs: config.loadDurationMs,
    loadMaxRate: config.loadMaxRate,
    loadPreAllocatedVus: config.loadPreAllocatedVus,
    loadMaxVus: config.loadMaxVus,
    loadScheduledRequests: config.loadScheduledRequests,
    loadRequiredRequestBudget: config.loadRequiredRequestBudget,
    loadRequestBudget: config.loadRequestBudget,
    spikeBaselineRps: config.spikeBaselineRps,
    spikePeakRps: config.spikePeakRps,
    spikeBaselineDuration: config.spikeBaselineDuration,
    spikePeakDuration: config.spikePeakDuration,
    spikeRecoveryDuration: config.spikeRecoveryDuration,
    spikeRecoveryMaxLatencyRatio: config.spikeRecoveryMaxLatencyRatio,
    confirmedSustainableRps: config.confirmedSustainableRps,
    confirmedCapacityRunId: config.confirmedCapacityRunId,
    soakRatePercent: config.soakRatePercent,
    soakRps: config.soakRps,
    soakDuration: config.soakDuration,
    fixtureSafetyPercent: config.fixtureSafetyPercent,
    fixtureSeedMode: config.fixtureSeedMode,
    fixtureSeedChunkSize: config.fixtureSeedChunkSize,
    fixtureLimits: {
      users: config.fixtureMaxUsers,
      seats: config.fixtureMaxSeats,
      databaseRows: config.fixtureMaxDatabaseRows,
      databaseBytes: config.fixtureMaxDatabaseBytes,
      redisBytes: config.fixtureMaxRedisBytes,
      storageBytes: config.fixtureMaxStorageBytes,
    },
    fixtureCapacityPlan: config.fixtureCapacityPlan,
    loadSetupAllowance: config.loadSetupAllowance,
    loadDrainAllowance: config.loadDrainAllowance,
    loadAuditAllowance: config.loadAuditAllowance,
    authenticationSafety: config.loadTokenSafety,
    authenticationTtl: config.loadAccessTokenTtl,
    authenticationTtlSeconds: config.loadAccessTokenTtlSeconds,
    requiredAuthenticationTtlMs: config.loadRequiredTokenTtlMs,
    watchdog: {
      pollIntervalMs: config.watchdogPollIntervalMs,
      consecutiveViolations: config.watchdogConsecutiveViolations,
      maxUnexpectedErrorRate: config.watchdogMaxUnexpectedErrorRate,
      maxDatabaseConnectionRatio: config.watchdogMaxDatabaseConnectionRatio,
      maxEventLoopLagMs: config.watchdogMaxEventLoopLagMs,
      maxGeneratorCpuPercent: config.watchdogMaxGeneratorCpuPercent,
      maxQueueDepth: config.watchdogMaxQueueDepth,
    },
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
