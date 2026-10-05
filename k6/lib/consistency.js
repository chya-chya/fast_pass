export const REQUEST_ASSIGNMENT = 'global_iteration_modulo';
export const REBOOKING_ASSIGNMENT = 'rebooking_sequence';

export function requestIdFor(runId, globalIterationId) {
  if (!Number.isInteger(globalIterationId) || globalIterationId < 0) {
    throw new Error('global iteration ID must be a non-negative integer');
  }
  return `${runId}-req-${String(globalIterationId).padStart(6, '0')}`;
}

export function assignmentFor(globalIterationId, userIds, seatIds) {
  if (
    !Array.isArray(userIds) ||
    !userIds.length ||
    !Array.isArray(seatIds) ||
    !seatIds.length
  ) {
    throw new Error('assignment requires non-empty user and seat IDs');
  }
  return {
    requestIndex: globalIterationId,
    userId: userIds[globalIterationId % userIds.length],
    seatId: seatIds[globalIterationId % seatIds.length],
  };
}

export function buildExpectedRequestManifest(
  runId,
  totalRequests,
  userIds,
  seatIds,
  assignment = REQUEST_ASSIGNMENT,
) {
  if (assignment === REBOOKING_ASSIGNMENT) {
    if (totalRequests !== 2 || userIds.length !== 1 || seatIds.length !== 1) {
      throw new Error(
        'rebooking manifest requires two requests, one user, and one seat',
      );
    }
    return {
      requests: {
        [`${runId}-req-first`]: { userId: userIds[0], seatId: seatIds[0] },
        [`${runId}-req-second`]: { userId: userIds[0], seatId: seatIds[0] },
      },
      requestsPerSeat: { [seatIds[0]]: 2 },
    };
  }
  if (assignment !== REQUEST_ASSIGNMENT) {
    throw new Error('request manifest assignment is unsupported');
  }
  const requests = {};
  const requestsPerSeat = Object.fromEntries(
    seatIds.map((seatId) => [seatId, 0]),
  );
  for (let index = 0; index < totalRequests; index += 1) {
    const assignment = assignmentFor(index, userIds, seatIds);
    requests[requestIdFor(runId, index)] = {
      userId: assignment.userId,
      seatId: assignment.seatId,
    };
    requestsPerSeat[assignment.seatId] += 1;
  }
  return { requests, requestsPerSeat };
}
