import { requestIdFor } from './consistency.js';

export function buildCompactTrackingAuditInputs({
  runId,
  expectedRequests = {},
  reservations,
  attempted,
  accepted,
  processed,
  failed,
}) {
  const rowsByRequestId = new Map(
    reservations
      .filter((row) => typeof row.testRequestId === 'string')
      .map((row) => [row.testRequestId, row]),
  );
  const requestIdAt = (index) => requestIdFor(runId, index);
  const actualRequests = Object.fromEntries(
    attempted.map((index) => {
      const requestId = requestIdAt(index);
      return [requestId, expectedRequests[requestId] || null];
    }),
  );
  for (const row of reservations) {
    if (typeof row.testRequestId !== 'string') continue;
    actualRequests[row.testRequestId] = {
      userId: row.userId,
      seatId: row.seatId,
    };
  }
  const reservationIdForIndex = (kind, index) => {
    const requestId = requestIdAt(index);
    return rowsByRequestId.get(requestId)?.id || `compact-${kind}-${index}`;
  };
  return {
    actualRequests,
    acceptedMappings: Object.fromEntries(
      accepted.map((index) => [
        reservationIdForIndex('accepted', index),
        requestIdAt(index),
      ]),
    ),
    processedIds: processed.map((index) =>
      reservationIdForIndex('processed', index),
    ),
    failedMappings: Object.fromEntries(
      failed.map((index) => [`compact-failed-${index}`, requestIdAt(index)]),
    ),
  };
}
