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

export function updateViolationCounters(previous, current, requiredSamples) {
  const active = new Set(current);
  const counts = {};
  for (const code of WATCHDOG_CODES) {
    counts[code] = active.has(code) ? Number(previous[code] || 0) + 1 : 0;
  }
  return {
    counts,
    abortReason:
      WATCHDOG_CODES.find((code) => counts[code] >= requiredSamples) || null,
  };
}
