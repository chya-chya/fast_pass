import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applySafetyMargin,
  buildFixtureCapacityPlan,
  buildLongRunVerdict,
  estimateSoakRequests,
  estimateSpikeRequestBudget,
  estimateSpikeRequests,
  longRunIterationIndices,
  spikePhaseOffsets,
} from '../lib/endurance.js';

test('sizes spike and soak fixtures before execution', () => {
  const spikeRequests = estimateSpikeRequests({
    baselineRps: 300,
    peakRps: 1000,
    baselineDurationMs: 120000,
    peakDurationMs: 30000,
    recoveryDurationMs: 180000,
  });
  assert.equal(spikeRequests, 120000);
  assert.equal(applySafetyMargin(spikeRequests, 110), 132000);
  assert.equal(
    estimateSpikeRequestBudget({
      baselineRps: 2,
      peakRps: 4,
      baselineDurationMs: 1000,
      peakDurationMs: 1000,
      recoveryDurationMs: 1000,
      safetyPercent: 110,
    }),
    11,
  );
  assert.equal(estimateSoakRequests(325, 3600000), 1170000);
});

test('reports database, Redis, seed, and cleanup capacity', () => {
  assert.deepEqual(
    buildFixtureCapacityPlan({
      requestBudget: 1000,
      userCount: 100,
      databaseBytesPerRequest: 512,
      redisBytesPerRequest: 256,
      seedRowsPerSecond: 200,
      cleanupRowsPerSecond: 100,
    }),
    {
      users: 100,
      seats: 1000,
      expectedReservationRows: 1000,
      expectedDatabaseRows: 2102,
      estimatedDatabaseBytes: 512000,
      estimatedRedisBytes: 256000,
      estimatedStorageBytes: 512000,
      estimatedSeedSeconds: 5,
      estimatedCleanupSeconds: 10,
    },
  );
});

test('keeps spike scenario iteration ranges disjoint', () => {
  assert.deepEqual(
    spikePhaseOffsets({
      spikeBaselineRps: 2,
      spikePeakRps: 4,
      spikeBaselineDurationMs: 2000,
      spikePeakDurationMs: 1000,
      fixtureSafetyPercent: 110,
    }),
    { baseline: 0, peak: 5, recovery: 10 },
  );
});

test('reconstructs the exact disjoint Spike request indices for audit', () => {
  assert.deepEqual(
    longRunIterationIndices(
      {
        scenario: 'spike',
        spikeBaselineRps: 2,
        spikePeakRps: 4,
        spikeBaselineDurationMs: 3000,
        spikePeakDurationMs: 2000,
        fixtureSafetyPercent: 110,
        loadRequestBudget: 64,
      },
      { baseline: 7, peak: 9, recovery: 9 },
    ),
    [
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24,
    ],
  );
});

test('does not treat reduced long-run checks as qualification', () => {
  assert.deepEqual(
    buildLongRunVerdict({ scenario: 'soak', loadTestReduced: true }, [], 0),
    {
      kind: 'endurance-preflight',
      status: 'NOT_APPLICABLE',
      integrationChecksPassed: true,
      reasons: [],
      failedMetrics: [],
    },
  );
});
