export const LONG_RUN_SCENARIOS = Object.freeze(['spike', 'soak']);
export const SPIKE_PHASES = Object.freeze(['baseline', 'peak', 'recovery']);

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export function estimateSpikeRequests({
  baselineRps,
  peakRps,
  baselineDurationMs,
  peakDurationMs,
  recoveryDurationMs,
}) {
  for (const [label, value] of Object.entries({ baselineRps, peakRps })) {
    assertPositiveInteger(value, label);
  }
  for (const [label, value] of Object.entries({
    baselineDurationMs,
    peakDurationMs,
    recoveryDurationMs,
  })) {
    assertPositiveInteger(value, label);
  }
  return Math.ceil(
    (baselineRps * (baselineDurationMs + recoveryDurationMs) +
      peakRps * peakDurationMs) /
      1000,
  );
}

export function estimateSpikeRequestBudget({
  baselineRps,
  peakRps,
  baselineDurationMs,
  peakDurationMs,
  recoveryDurationMs,
  safetyPercent,
}) {
  return (
    applySafetyMargin(
      estimateSoakRequests(baselineRps, baselineDurationMs),
      safetyPercent,
    ) +
    applySafetyMargin(
      estimateSoakRequests(peakRps, peakDurationMs),
      safetyPercent,
    ) +
    applySafetyMargin(
      estimateSoakRequests(baselineRps, recoveryDurationMs),
      safetyPercent,
    )
  );
}

export function estimateSoakRequests(rate, durationMs) {
  assertPositiveInteger(rate, 'rate');
  assertPositiveInteger(durationMs, 'durationMs');
  return Math.ceil((rate * durationMs) / 1000);
}

export function applySafetyMargin(requests, safetyPercent) {
  assertPositiveInteger(requests, 'requests');
  if (
    !Number.isInteger(safetyPercent) ||
    safetyPercent < 100 ||
    safetyPercent > 200
  ) {
    throw new Error('safetyPercent must be between 100 and 200');
  }
  return Math.ceil((requests * safetyPercent) / 100);
}

export function buildFixtureCapacityPlan({
  requestBudget,
  userCount,
  databaseBytesPerRequest,
  redisBytesPerRequest,
  seedRowsPerSecond,
  cleanupRowsPerSecond,
}) {
  for (const [label, value] of Object.entries({
    requestBudget,
    userCount,
    databaseBytesPerRequest,
    redisBytesPerRequest,
    seedRowsPerSecond,
    cleanupRowsPerSecond,
  })) {
    assertPositiveInteger(value, label);
  }
  const expectedReservationRows = requestBudget;
  const expectedSeatRows = requestBudget;
  const expectedDatabaseRows =
    userCount + expectedSeatRows + expectedReservationRows + 2;
  return Object.freeze({
    users: userCount,
    seats: expectedSeatRows,
    expectedReservationRows,
    expectedDatabaseRows,
    estimatedDatabaseBytes: requestBudget * databaseBytesPerRequest,
    estimatedRedisBytes: requestBudget * redisBytesPerRequest,
    estimatedStorageBytes: requestBudget * databaseBytesPerRequest,
    estimatedSeedSeconds: Math.ceil(requestBudget / seedRowsPerSecond),
    estimatedCleanupSeconds: Math.ceil(requestBudget / cleanupRowsPerSecond),
  });
}

export function spikePhaseOffsets(config) {
  const baselineRequestRange = applySafetyMargin(
    estimateSoakRequests(
      config.spikeBaselineRps,
      config.spikeBaselineDurationMs,
    ),
    config.fixtureSafetyPercent,
  );
  const peakRequestRange = applySafetyMargin(
    estimateSoakRequests(config.spikePeakRps, config.spikePeakDurationMs),
    config.fixtureSafetyPercent,
  );
  return Object.freeze({
    baseline: 0,
    peak: baselineRequestRange,
    recovery: baselineRequestRange + peakRequestRange,
  });
}

export function longRunIterationIndices(config, phaseCounts) {
  if (config.scenario === 'soak') {
    const count = phaseCounts.soak;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error('soak request count is invalid');
    }
    return Array.from({ length: count }, (_, index) => index);
  }
  if (config.scenario !== 'spike') {
    throw new Error('long-run scenario is unsupported');
  }
  const offsets = spikePhaseOffsets(config);
  const indices = [];
  for (const phase of SPIKE_PHASES) {
    const count = phaseCounts[phase];
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`spike ${phase} request count is invalid`);
    }
    for (let index = 0; index < count; index += 1) {
      indices.push(offsets[phase] + index);
    }
  }
  if (indices.some((index) => index >= config.loadRequestBudget)) {
    throw new Error('long-run request count exceeds the fixture budget');
  }
  return indices;
}

export function buildLongRunVerdict(
  config,
  thresholdFailures,
  droppedIterations,
) {
  const failedMetrics = [
    ...new Set(thresholdFailures.map((failure) => failure.metric)),
  ].sort();
  const reasons = [];
  if (droppedIterations > 0) reasons.push('DROPPED_ITERATIONS');
  if (failedMetrics.length > 0) reasons.push('LOAD_THRESHOLD_EXCEEDED');
  if (config.loadTestReduced) {
    return {
      kind:
        config.scenario === 'spike'
          ? 'recovery-preflight'
          : 'endurance-preflight',
      status: 'NOT_APPLICABLE',
      integrationChecksPassed: reasons.length === 0,
      reasons,
      failedMetrics,
    };
  }
  return {
    kind: config.scenario === 'spike' ? 'recovery' : 'endurance',
    status: reasons.length === 0 ? 'PASS' : 'FAIL',
    reasons,
    failedMetrics,
  };
}
