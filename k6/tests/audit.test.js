import assert from 'node:assert/strict';
import test from 'node:test';

import { buildConsistencyAudit, isDrainCandidate } from '../lib/audit.js';

function validInput() {
  return {
    runId: 'audit-test',
    testEnvId: 'audit-env',
    performanceId: 'performance-1',
    producerState: 'COMPLETED',
    summaryAccepted: 2,
    acceptedMappings: {
      'reservation-1': 'request-1',
      'reservation-2': 'request-2',
    },
    processedIds: ['reservation-1', 'reservation-2'],
    failedMappings: {},
    counters: {
      enqueue: 2,
      processing_started: 2,
      processed_success: 2,
      processed_failure: 0,
      retry: 0,
      dlq: 0,
      worker_in_flight: 0,
      max_queue_depth: 2,
    },
    queues: { pending: 0, processing: 0, retry: 0, dlq: 0 },
    drain: {
      timedOut: false,
      timeoutMs: 30000,
      pollMs: 100,
      stableMs: 1000,
      elapsedMs: 1200,
    },
    foreignQueueMessages: 0,
    db: {
      reservations: [
        { id: 'reservation-1', seatId: 'seat-1', status: 'PENDING' },
        { id: 'reservation-2', seatId: 'seat-2', status: 'PENDING' },
      ],
      seatStatusDistribution: { HELD: 2 },
      reservationStatusDistribution: { PENDING: 2 },
    },
  };
}

test('passes only when accepted, processed, and persisted ID sets match', () => {
  const audit = buildConsistencyAudit(validInput());
  assert.equal(audit.consistency.pass, true);
  assert.deepEqual(audit.consistency.reasons, []);
  assert.equal(audit.counters.conservationDifference, 0);
});

test('fails equal counts with different persisted IDs', () => {
  const input = validInput();
  input.db.reservations[1].id = 'reservation-other';
  const audit = buildConsistencyAudit(input);
  assert.equal(audit.consistency.pass, false);
  assert.ok(audit.consistency.reasons.includes('MISSING_PERSISTED_ID'));
  assert.ok(audit.consistency.reasons.includes('UNEXPECTED_PERSISTED_ID'));
});

test('fails when in-flight work or DLQ remains', () => {
  const input = validInput();
  input.queues.processing = 1;
  input.queues.dlq = 1;
  input.counters.worker_in_flight = 1;
  input.counters.dlq = 1;
  const audit = buildConsistencyAudit(input);
  assert.equal(audit.consistency.pass, false);
  assert.ok(audit.consistency.reasons.includes('PROCESSING_NOT_EMPTY'));
  assert.ok(audit.consistency.reasons.includes('DLQ_NOT_EMPTY'));
  assert.ok(audit.consistency.reasons.includes('WORKER_IN_FLIGHT'));
});

test('drain candidate requires producer completion and zero in-flight queues', () => {
  const sample = {
    producerState: 'COMPLETED',
    pending: 0,
    processing: 0,
    retry: 0,
    workerInFlight: 0,
  };
  assert.equal(isDrainCandidate(sample), true);
  assert.equal(isDrainCandidate({ ...sample, pending: 1 }), false);
  assert.equal(isDrainCandidate({ ...sample, processing: 1 }), false);
  assert.equal(isDrainCandidate({ ...sample, retry: 1 }), false);
  assert.equal(isDrainCandidate({ ...sample, workerInFlight: 1 }), false);
  assert.equal(isDrainCandidate({ ...sample, producerState: 'OPEN' }), false);
});

test('audits the immutable request manifest and exact outcome counts', () => {
  const input = validInput();
  input.counters.attempts = 2;
  input.summaryConflicts = 0;
  input.summaryUnexpectedErrors = 0;
  input.summaryTimeouts = 0;
  input.summaryIterations = 2;
  input.expectedIterations = 2;
  input.expectedAccepted = 2;
  input.expectedConflicts = 0;
  input.cacheProfile = 'warm';
  input.cacheProfileState = 'warm';
  input.expectedRequests = {
    'request-1': { userId: 'user-1', seatId: 'seat-1' },
    'request-2': { userId: 'user-2', seatId: 'seat-2' },
  };
  input.actualRequests = structuredClone(input.expectedRequests);
  input.expectedRequestsPerSeat = { 'seat-1': 1, 'seat-2': 1 };
  const audit = buildConsistencyAudit(input);
  assert.equal(audit.consistency.pass, true);
  assert.deepEqual(audit.requestAudit.actualRequestsPerSeat, {
    'seat-1': 1,
    'seat-2': 1,
  });

  input.actualRequests['request-2'].seatId = 'seat-1';
  const failed = buildConsistencyAudit(input);
  assert.equal(failed.consistency.pass, false);
  assert.ok(failed.consistency.reasons.includes('REQUEST_ASSIGNMENT_MISMATCH'));
  assert.ok(
    failed.consistency.reasons.includes('REQUEST_DISTRIBUTION_MISMATCH'),
  );
});

test('allows cancelled history but requires one active rebooking reservation', () => {
  const input = validInput();
  input.runId = 'rebooking-run';
  input.scenario = 'rebooking';
  input.summaryAccepted = 2;
  input.summaryConflicts = 0;
  input.summaryUnexpectedErrors = 0;
  input.summaryTimeouts = 0;
  input.summaryIterations = 1;
  input.summaryFirstAccepted = 1;
  input.summarySecondAccepted = 1;
  input.expectedIterations = 1;
  input.expectedAccepted = 2;
  input.expectedConflicts = 0;
  input.cacheProfile = 'warm';
  input.cacheProfileState = 'warm';
  input.counters.attempts = 2;
  input.acceptedMappings = {
    'reservation-1': 'rebooking-run-req-first',
    'reservation-2': 'rebooking-run-req-second',
  };
  input.expectedRequests = {
    'rebooking-run-req-first': { userId: 'user-1', seatId: 'seat-1' },
    'rebooking-run-req-second': { userId: 'user-1', seatId: 'seat-1' },
  };
  input.actualRequests = structuredClone(input.expectedRequests);
  input.expectedRequestsPerSeat = { 'seat-1': 2 };
  input.db.reservations = [
    { id: 'reservation-1', seatId: 'seat-1', status: 'CANCELLED' },
    { id: 'reservation-2', seatId: 'seat-1', status: 'PENDING' },
  ];
  input.db.seatStatusById = { 'seat-1': 'HELD' };
  input.redisSeatStatuses = { 'seat-1': 'HELD' };
  const audit = buildConsistencyAudit(input);
  assert.equal(audit.consistency.pass, true);
  assert.equal(audit.database.duplicateSeats.length, 1);
  assert.deepEqual(audit.database.duplicateActiveSeats, []);
  assert.equal(audit.rebooking.firstStatus, 'CANCELLED');
  assert.equal(audit.rebooking.secondStatus, 'PENDING');
});
