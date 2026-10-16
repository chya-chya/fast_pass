import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCompactTrackingAuditInputs } from '../lib/compact-tracking.js';

test('reconstructs compact tracking from bitmap indices and persisted rows', () => {
  const runId = 'compact-run';
  const requestId = `${runId}-req-000000`;
  const result = buildCompactTrackingAuditInputs({
    runId,
    expectedRequests: {
      [requestId]: { userId: 'user-1', seatId: 'seat-1' },
    },
    reservations: [
      {
        id: 'reservation-1',
        testRequestId: requestId,
        userId: 'user-1',
        seatId: 'seat-1',
      },
    ],
    attempted: [0],
    accepted: [0],
    processed: [0],
    failed: [],
  });
  assert.deepEqual(result.acceptedMappings, {
    'reservation-1': requestId,
  });
  assert.deepEqual(result.processedIds, ['reservation-1']);
  assert.deepEqual(result.actualRequests[requestId], {
    userId: 'user-1',
    seatId: 'seat-1',
  });
  assert.deepEqual(result.failedMappings, {});
});

test('uses distinct placeholders when persistence or processing is missing', () => {
  const result = buildCompactTrackingAuditInputs({
    runId: 'compact-run',
    reservations: [],
    attempted: [3],
    accepted: [3],
    processed: [4],
    failed: [5],
  });
  assert.deepEqual(Object.keys(result.acceptedMappings), [
    'compact-accepted-3',
  ]);
  assert.deepEqual(result.processedIds, ['compact-processed-4']);
  assert.deepEqual(Object.keys(result.failedMappings), ['compact-failed-5']);
});
