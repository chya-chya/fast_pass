import { requestIdFor } from './consistency.js';

export const CAPACITY_PROFILES = Object.freeze(['unique-seat', 'hot-seat']);

export const CAPACITY_ASSIGNMENTS = Object.freeze({
  'unique-seat': 'global_iteration_unique_seat',
  'hot-seat': 'global_iteration_hot_seat',
});

export function estimateCapacityRequestBudget(
  targets,
  holdDurationsMs,
  rampDurationMs,
  thinkTimeMs,
) {
  if (
    !Array.isArray(targets) ||
    targets.length !== 4 ||
    !Array.isArray(holdDurationsMs) ||
    holdDurationsMs.length !== targets.length ||
    !Number.isFinite(rampDurationMs) ||
    rampDurationMs <= 0 ||
    !Number.isFinite(thinkTimeMs) ||
    thinkTimeMs <= 0
  ) {
    throw new Error('capacity budget inputs are invalid');
  }

  let vuMilliseconds = 0;
  for (let index = 0; index < targets.length; index += 1) {
    vuMilliseconds += targets[index] * rampDurationMs;
    vuMilliseconds += targets[index] * holdDurationsMs[index];
  }
  vuMilliseconds += targets[targets.length - 1] * rampDurationMs;

  return Math.ceil(vuMilliseconds / thinkTimeMs) + Math.max(...targets);
}

export function capacityStageWindows(targets, holdDurationsMs, rampDurationMs) {
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

export function capacityStageIndex(elapsedMs, windows) {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  const match = windows.find(
    (window) => elapsedMs >= window.startedAtMs && elapsedMs < window.endedAtMs,
  );
  return match ? match.index : windows.length - 1;
}

export function capacityAssignmentFor(
  globalIterationId,
  userIds,
  seatIds,
  profile,
  requestBudget,
) {
  if (
    !Number.isInteger(globalIterationId) ||
    globalIterationId < 0 ||
    globalIterationId >= requestBudget
  ) {
    throw new Error('capacity global iteration exceeds the request budget');
  }
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw new Error('capacity assignment requires pre-issued users');
  }
  if (!Array.isArray(seatIds) || seatIds.length === 0) {
    throw new Error('capacity assignment requires fixture seats');
  }
  if (!CAPACITY_PROFILES.includes(profile)) {
    throw new Error('capacity profile is unsupported');
  }
  if (profile === 'unique-seat' && seatIds.length < requestBudget) {
    throw new Error('unique-seat fixture is smaller than the request budget');
  }

  return {
    requestIndex: globalIterationId,
    userId: userIds[globalIterationId % userIds.length],
    seatId: profile === 'unique-seat' ? seatIds[globalIterationId] : seatIds[0],
  };
}

export function buildCapacityExpectedRequestManifest(
  runId,
  totalRequests,
  userIds,
  seatIds,
  profile,
  requestBudget,
) {
  if (
    !Number.isInteger(totalRequests) ||
    totalRequests < 0 ||
    totalRequests > requestBudget
  ) {
    throw new Error('capacity request count exceeds the fixture budget');
  }
  const requests = {};
  const requestsPerSeat = {};
  for (let index = 0; index < totalRequests; index += 1) {
    const assignment = capacityAssignmentFor(
      index,
      userIds,
      seatIds,
      profile,
      requestBudget,
    );
    requests[requestIdFor(runId, index)] = {
      userId: assignment.userId,
      seatId: assignment.seatId,
    };
    requestsPerSeat[assignment.seatId] =
      (requestsPerSeat[assignment.seatId] || 0) + 1;
  }
  return { requests, requestsPerSeat };
}
