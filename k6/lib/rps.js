export const RPS_TEST_PROFILES = Object.freeze([
  'explore',
  'confirm-50',
  'confirm-75',
  'confirm-100',
  'confirm-110',
]);

export const RPS_CONFIRMATION_PERCENT = Object.freeze({
  'confirm-50': 50,
  'confirm-75': 75,
  'confirm-100': 100,
  'confirm-110': 110,
});

export function estimateExplorationRequestBudget(
  targets,
  holdDurationsMs,
  rampDurationMs,
) {
  if (
    !Array.isArray(targets) ||
    targets.length !== 4 ||
    !Array.isArray(holdDurationsMs) ||
    holdDurationsMs.length !== targets.length ||
    !Number.isFinite(rampDurationMs) ||
    rampDurationMs <= 0
  ) {
    throw new Error('RPS exploration budget inputs are invalid');
  }
  let requestBudget = 0;
  for (let index = 0; index < targets.length; index += 1) {
    requestBudget +=
      (targets[index] * (rampDurationMs + holdDurationsMs[index])) / 1000;
  }
  requestBudget += (targets[targets.length - 1] * rampDurationMs) / 1000;
  return Math.ceil(requestBudget);
}

export function estimateConfirmationRequestBudget(rate, durationMs) {
  if (
    !Number.isInteger(rate) ||
    rate < 1 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    throw new Error('RPS confirmation budget inputs are invalid');
  }
  return Math.ceil((rate * durationMs) / 1000);
}

export function rpsStageWindows(targets, holdDurationsMs, rampDurationMs) {
  let cursor = 0;
  return targets.map((target, index) => {
    const startedAtMs = cursor;
    const durationMs =
      rampDurationMs +
      holdDurationsMs[index] +
      (index === targets.length - 1 ? rampDurationMs : 0);
    cursor += durationMs;
    return Object.freeze({
      index,
      target,
      startedAtMs,
      endedAtMs: cursor,
      durationMs,
    });
  });
}

export function rpsStageIndex(elapsedMs, windows) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  const match = windows.find(
    (window) => elapsedMs >= window.startedAtMs && elapsedMs < window.endedAtMs,
  );
  return match ? match.index : windows.length - 1;
}

export function buildRpsVerdict(config, thresholdFailures, droppedIterations) {
  const reasons = [];
  if (droppedIterations > 0) reasons.push('DROPPED_ITERATIONS');
  const failedMetrics = [
    ...new Set(thresholdFailures.map((failure) => failure.metric)),
  ].sort();
  if (
    failedMetrics.some((metric) =>
      [
        'accepted_duration_ms',
        'expected_conflict_duration_ms',
        'unexpected_error_duration_ms',
      ].includes(metric),
    )
  ) {
    reasons.push('LATENCY_THRESHOLD_EXCEEDED');
  }
  if (
    failedMetrics.some((metric) =>
      ['checks', 'unexpected_error', 'timeout'].includes(metric),
    )
  ) {
    reasons.push('REQUEST_QUALITY_THRESHOLD_EXCEEDED');
  }
  if (
    failedMetrics.some(
      (metric) =>
        metric !== 'dropped_iterations' &&
        ![
          'accepted_duration_ms',
          'expected_conflict_duration_ms',
          'unexpected_error_duration_ms',
          'checks',
          'unexpected_error',
          'timeout',
        ].includes(metric),
    )
  ) {
    reasons.push('OTHER_THRESHOLD_EXCEEDED');
  }

  if (config.rpsTestProfile === 'explore') {
    return {
      kind: 'exploratory',
      status: reasons.length > 0 ? 'LIMIT_FOUND' : 'LIMIT_NOT_FOUND',
      regressionStatus: 'NOT_APPLICABLE',
      reasons,
      failedMetrics,
    };
  }
  if (config.rpsTestProfile === 'confirm-110') {
    return {
      kind: 'exploratory-overload',
      status: 'NOT_APPLICABLE',
      limitStatus: reasons.length > 0 ? 'LIMIT_FOUND' : 'LIMIT_NOT_FOUND',
      reasons,
      failedMetrics,
    };
  }
  return {
    kind: 'capacity-confirmation',
    status: reasons.length === 0 ? 'PASS' : 'FAIL',
    reasons,
    failedMetrics,
  };
}
