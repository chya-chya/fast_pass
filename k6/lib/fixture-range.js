export function fixtureId(runId, kind, index = null) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(runId)) {
    throw new Error('fixture run ID is invalid');
  }
  if (!['user', 'event', 'performance', 'seat'].includes(kind)) {
    throw new Error('fixture ID kind is invalid');
  }
  if (index === null) return `${runId}-${kind}`;
  if (!Number.isInteger(index) || index < 0 || index > 99_999_999) {
    throw new Error('fixture index is invalid');
  }
  return `${runId}-${kind}-${String(index).padStart(8, '0')}`;
}

export function fixtureEmail(runId, index) {
  return `${fixtureId(runId, 'user', index)}@load.invalid`;
}

export function rangeAssignment(iteration, runId, userCount, seatCount) {
  if (
    !Number.isInteger(iteration) ||
    iteration < 0 ||
    !Number.isInteger(userCount) ||
    userCount < 1 ||
    !Number.isInteger(seatCount) ||
    iteration >= seatCount
  ) {
    throw new Error('fixture range assignment is invalid');
  }
  return {
    requestIndex: iteration,
    userId: fixtureId(runId, 'user', iteration % userCount),
    seatId: fixtureId(runId, 'seat', iteration),
  };
}
