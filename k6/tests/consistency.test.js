import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignmentFor,
  buildExpectedRequestManifest,
  REBOOKING_ASSIGNMENT,
  requestIdFor,
} from '../lib/consistency.js';

test('maps 1000 global iterations evenly across 50 seats', () => {
  const users = Array.from({ length: 1000 }, (_, index) => `user-${index}`);
  const seats = Array.from({ length: 50 }, (_, index) => `seat-${index}`);
  const manifest = buildExpectedRequestManifest(
    'inventory-run',
    1000,
    users,
    seats,
  );
  assert.equal(Object.keys(manifest.requests).length, 1000);
  assert.deepEqual(
    new Set(Object.values(manifest.requestsPerSeat)),
    new Set([20]),
  );
  assert.deepEqual(manifest.requests[requestIdFor('inventory-run', 999)], {
    userId: 'user-999',
    seatId: 'seat-49',
  });
});

test('builds distinct immutable request IDs for a rebooking sequence', () => {
  const manifest = buildExpectedRequestManifest(
    'rebooking-run',
    2,
    ['user-1'],
    ['seat-1'],
    REBOOKING_ASSIGNMENT,
  );
  assert.deepEqual(manifest.requests, {
    'rebooking-run-req-first': { userId: 'user-1', seatId: 'seat-1' },
    'rebooking-run-req-second': { userId: 'user-1', seatId: 'seat-1' },
  });
  assert.deepEqual(manifest.requestsPerSeat, { 'seat-1': 2 });
});

test('segment partitions preserve the same global mapping without VU IDs', () => {
  const users = Array.from({ length: 10 }, (_, index) => `user-${index}`);
  const seats = ['seat-0', 'seat-1'];
  const even = [0, 2, 4, 6, 8].map((id) => assignmentFor(id, users, seats));
  const odd = [1, 3, 5, 7, 9].map((id) => assignmentFor(id, users, seats));
  const merged = [...even, ...odd].sort(
    (left, right) => left.requestIndex - right.requestIndex,
  );
  assert.deepEqual(
    merged.map((entry) => entry.userId),
    users,
  );
  assert.deepEqual(
    merged.map((entry) => entry.seatId),
    Array.from({ length: 10 }, (_, index) => `seat-${index % 2}`),
  );
});
