export const WATCHDOG_CODES = Object.freeze([
  'UNEXPECTED_ERROR_RATE_HIGH',
  'DATABASE_CONNECTION_LIMIT_NEAR',
  'DATABASE_CPU_SATURATED',
  'REDIS_CPU_SATURATED',
  'REDIS_MEMORY_SATURATED',
  'EVENT_LOOP_LAG_HIGH',
  'LOAD_GENERATOR_CPU_SATURATED',
  'QUEUE_DEPTH_HIGH',
  'REDIS_EVICTION_OBSERVED',
  'APPLICATION_RESTART_OBSERVED',
  'ALB_UNHEALTHY_TARGET',
  'APP_CPU_CREDIT_LOW',
  'WATCHDOG_INPUT_UNAVAILABLE',
]);

export const CLOUDWATCH_WATCHDOG_CODES = Object.freeze([
  'DATABASE_CPU_SATURATED',
  'REDIS_CPU_SATURATED',
  'REDIS_MEMORY_SATURATED',
]);

export const CLOUDWATCH_RESOURCE_PERIOD_SECONDS = 60;
export const EC2_BASIC_PERIOD_SECONDS = 300;

export function assertCloudWatchMetricFresh(timestamp, now, maximumAge, label) {
  const observedAt = Date.parse(timestamp);
  if (
    !Number.isFinite(observedAt) ||
    observedAt > now + 60_000 ||
    now - observedAt > maximumAge
  ) {
    throw new Error(`${label} CloudWatch datapoint is stale`);
  }
}

export function conservativeCpuCreditBalance(
  observedBalance,
  observedAt,
  now = Date.now(),
  vcpus = 2,
) {
  const observedTimestamp = Date.parse(observedAt);
  if (
    !Number.isFinite(observedBalance) ||
    observedBalance < 0 ||
    !Number.isFinite(observedTimestamp) ||
    !Number.isFinite(now) ||
    now < observedTimestamp ||
    !Number.isInteger(vcpus) ||
    vcpus < 1
  ) {
    throw new Error('CPU credit observation is invalid');
  }
  const maximumConsumption = ((now - observedTimestamp) / 60_000) * vcpus;
  return Math.max(0, observedBalance - maximumConsumption);
}

export function evaluateWatchdogViolations(sample, thresholds) {
  const violations = [];
  if (sample.unexpectedErrorRate > thresholds.unexpectedErrorRate) {
    violations.push('UNEXPECTED_ERROR_RATE_HIGH');
  }
  if (sample.databaseConnectionRatio > thresholds.databaseConnectionRatio) {
    violations.push('DATABASE_CONNECTION_LIMIT_NEAR');
  }
  if (sample.databaseCpuPercent > thresholds.databaseCpuPercent) {
    violations.push('DATABASE_CPU_SATURATED');
  }
  if (sample.redisCpuPercent > thresholds.redisCpuPercent) {
    violations.push('REDIS_CPU_SATURATED');
  }
  if (sample.redisMemoryPercent > thresholds.redisMemoryPercent) {
    violations.push('REDIS_MEMORY_SATURATED');
  }
  if (sample.eventLoopLagMs > thresholds.eventLoopLagMs) {
    violations.push('EVENT_LOOP_LAG_HIGH');
  }
  if (sample.generatorCpuPercent > thresholds.generatorCpuPercent) {
    violations.push('LOAD_GENERATOR_CPU_SATURATED');
  }
  if (sample.queueDepth > thresholds.queueDepth) {
    violations.push('QUEUE_DEPTH_HIGH');
  }
  if (sample.redisEvictions > thresholds.redisEvictions) {
    violations.push('REDIS_EVICTION_OBSERVED');
  }
  if (sample.processRestarts > thresholds.processRestarts) {
    violations.push('APPLICATION_RESTART_OBSERVED');
  }
  if (sample.unhealthyTargets > thresholds.unhealthyTargets) {
    violations.push('ALB_UNHEALTHY_TARGET');
  }
  if (
    sample.minimumCpuCreditBalance !== null &&
    sample.minimumCpuCreditBalance < thresholds.minimumCpuCreditBalance
  ) {
    violations.push('APP_CPU_CREDIT_LOW');
  }
  return violations;
}

export function updateViolationCounters(
  previous,
  current,
  requiredSamples,
  evaluatedCodes = WATCHDOG_CODES,
) {
  const active = new Set(current);
  const evaluated = new Set(evaluatedCodes);
  const counts = {};
  for (const code of WATCHDOG_CODES) {
    counts[code] = evaluated.has(code)
      ? active.has(code)
        ? Number(previous[code] || 0) + 1
        : 0
      : Number(previous[code] || 0);
  }
  return {
    counts,
    abortReason:
      WATCHDOG_CODES.find((code) => counts[code] >= requiredSamples) || null,
  };
}

export function freshCloudWatchCodes(previous, current) {
  return CLOUDWATCH_WATCHDOG_CODES.filter((code) => {
    const currentTimestamp = Date.parse(current?.[code]);
    const previousTimestamp = Date.parse(previous?.[code]);
    return (
      Number.isFinite(currentTimestamp) &&
      (!Number.isFinite(previousTimestamp) ||
        currentTimestamp > previousTimestamp)
    );
  });
}

export function cloudWatchCodesOverlappingRun(
  observations,
  codes,
  runStartedAt,
  periodSeconds = CLOUDWATCH_RESOURCE_PERIOD_SECONDS,
) {
  const runStartedTimestamp = Date.parse(runStartedAt);
  if (
    !Number.isFinite(runStartedTimestamp) ||
    !Number.isInteger(periodSeconds) ||
    periodSeconds < 1
  ) {
    throw new Error('CloudWatch run coverage boundary is invalid');
  }
  return codes.filter((code) => {
    const observedTimestamp = Date.parse(observations?.[code]);
    return (
      Number.isFinite(observedTimestamp) &&
      observedTimestamp + periodSeconds * 1000 > runStartedTimestamp
    );
  });
}

export function hasIndependentCloudWatchCoverage(counts, requiredSamples) {
  return (
    Number.isInteger(requiredSamples) &&
    requiredSamples > 0 &&
    CLOUDWATCH_WATCHDOG_CODES.every(
      (code) => Number(counts?.[code] || 0) >= requiredSamples,
    )
  );
}
