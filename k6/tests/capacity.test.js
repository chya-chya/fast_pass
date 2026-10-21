import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCapacityExpectedRequestManifest,
  capacityAssignmentFor,
  capacityStageIndex,
  capacityStageWindows,
  estimateCapacityRequestBudget,
} from '../lib/capacity.js';

test('estimates a conservative request budget for four VU stages', () => {
  assert.equal(
    estimateCapacityRequestBudget(
      [1, 2, 3, 4],
      [2000, 2000, 2000, 2000],
      1000,
      1000,
    ),
    38,
  );
});

test('maps global iterations to unique seats without local VU identifiers', () => {
  const users = ['user-1', 'user-2'];
  const seats = ['seat-1', 'seat-2', 'seat-3', 'seat-4'];
  assert.deepEqual(capacityAssignmentFor(3, users, seats, 'unique-seat', 4), {
    requestIndex: 3,
    userId: 'user-2',
    seatId: 'seat-4',
  });
  const manifest = buildCapacityExpectedRequestManifest(
    'capacity-run',
    4,
    users,
    seats,
    'unique-seat',
    4,
  );
  assert.equal(Object.keys(manifest.requests).length, 4);
  assert.deepEqual(
    new Set(Object.values(manifest.requestsPerSeat)),
    new Set([1]),
  );
});

test('keeps the hot-seat profile on one immutable seat', () => {
  const manifest = buildCapacityExpectedRequestManifest(
    'hot-run',
    4,
    ['user-1', 'user-2'],
    ['seat-hot'],
    'hot-seat',
    10,
  );
  assert.deepEqual(manifest.requestsPerSeat, { 'seat-hot': 4 });
});

test('assigns elapsed load time to the configured stage window', () => {
  const windows = capacityStageWindows(
    [100, 500, 1000, 2000],
    [180000, 180000, 180000, 180000],
    30000,
  );
  assert.equal(capacityStageIndex(0, windows), 0);
  assert.equal(capacityStageIndex(210000, windows), 1);
  assert.equal(capacityStageIndex(630000, windows), 3);
});
