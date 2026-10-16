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
  fixtureId(runId, 'user', index);
  let hash = 2166136261;
  for (let offset = 0; offset < runId.length; offset += 1) {
    hash ^= runId.charCodeAt(offset);
    hash = Math.imul(hash, 16777619);
  }
  const token = runId.replace(/[^A-Za-z0-9]/g, '-');
  const localPart = [
    'k6',
    token.slice(0, 12),
    (hash >>> 0).toString(16).padStart(8, '0'),
    token.slice(-12),
    String(index).padStart(8, '0'),
  ].join('-');
  if (localPart.length > 64) {
    throw new Error('fixture email local part exceeds 64 characters');
  }
  return `${localPart}@load.invalid`;
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
