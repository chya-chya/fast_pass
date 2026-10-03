function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function difference(left, right) {
  const rightSet = new Set(right);
  return left.filter((value) => !rightSet.has(value));
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isDrainCandidate(sample) {
  return (
    sample.producerState === 'COMPLETED' &&
    sample.pending === 0 &&
    sample.processing === 0 &&
    sample.retry === 0 &&
    sample.workerInFlight === 0
  );
}

export function drainSignature(sample) {
  return JSON.stringify({
    producerState: sample.producerState,
    pending: sample.pending,
    processing: sample.processing,
    retry: sample.retry,
    dlq: sample.dlq,
    workerInFlight: sample.workerInFlight,
    enqueue: numeric(sample.counters.enqueue),
    processedSuccess: numeric(sample.counters.processed_success),
    processedFailure: numeric(sample.counters.processed_failure),
  });
}

export function buildConsistencyAudit(input) {
  const acceptedReservationIds = sortedUnique(
    Object.keys(input.acceptedMappings),
  );
  const acceptedRequestIds = sortedUnique(
    Object.values(input.acceptedMappings),
  );
  const persistedReservationIds = sortedUnique(
    input.db.reservations.map((reservation) => reservation.id),
  );
  const processedReservationIds = sortedUnique(input.processedIds);
  const failedReservationIds = sortedUnique(Object.keys(input.failedMappings));
  const missingPersistedIds = difference(
    acceptedReservationIds,
    persistedReservationIds,
  );
  const unexpectedPersistedIds = difference(
    persistedReservationIds,
    acceptedReservationIds,
  );
  const missingProcessedIds = difference(
    acceptedReservationIds,
    processedReservationIds,
  );
  const unexpectedProcessedIds = difference(
    processedReservationIds,
    acceptedReservationIds,
  );

  const seatCounts = new Map();
  for (const reservation of input.db.reservations) {
    seatCounts.set(
      reservation.seatId,
      (seatCounts.get(reservation.seatId) || 0) + 1,
    );
  }
  const duplicateSeats = [...seatCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([seatId, count]) => ({ seatId, count }))
    .sort((left, right) => left.seatId.localeCompare(right.seatId));
  const activeSeatCounts = new Map();
  for (const reservation of input.db.reservations) {
    if (!['PENDING', 'CONFIRMED'].includes(reservation.status)) continue;
    activeSeatCounts.set(
      reservation.seatId,
      (activeSeatCounts.get(reservation.seatId) || 0) + 1,
    );
  }
  const duplicateActiveSeats = [...activeSeatCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([seatId, count]) => ({ seatId, count }))
    .sort((left, right) => left.seatId.localeCompare(right.seatId));

  const counters = {
    attempts: numeric(input.counters.attempts),
    enqueue: numeric(input.counters.enqueue),
    processingStarted: numeric(input.counters.processing_started),
    processedSuccess: numeric(input.counters.processed_success),
    processedFailure: numeric(input.counters.processed_failure),
    retry: numeric(input.counters.retry),
    dlq: numeric(input.counters.dlq),
    workerInFlight: numeric(input.counters.worker_in_flight),
    maxQueueDepth: numeric(input.counters.max_queue_depth),
  };
  const conservationDifference =
    counters.enqueue -
    counters.processedSuccess -
    counters.processedFailure -
    counters.workerInFlight;
  const reasons = [];
  let requestAudit = null;

  if (input.producerState !== 'COMPLETED')
    reasons.push('PRODUCER_NOT_COMPLETE');
  if (input.drain.timedOut) reasons.push('DRAIN_TIMEOUT');
  if (input.queues.pending !== 0) reasons.push('PENDING_NOT_EMPTY');
  if (input.queues.processing !== 0) reasons.push('PROCESSING_NOT_EMPTY');
  if (input.queues.retry !== 0) reasons.push('RETRY_NOT_EMPTY');
  if (input.queues.dlq !== 0 || counters.dlq !== 0)
    reasons.push('DLQ_NOT_EMPTY');
  if (counters.workerInFlight !== 0) reasons.push('WORKER_IN_FLIGHT');
  if (counters.processedFailure !== 0) reasons.push('PROCESSING_FAILURE');
  if (counters.retry !== 0) reasons.push('RETRY_OBSERVED');
  if (conservationDifference !== 0) reasons.push('CONSERVATION_MISMATCH');
  if (input.summaryAccepted !== acceptedReservationIds.length)
    reasons.push('ACCEPTED_COUNT_MISMATCH');
  if (acceptedRequestIds.length !== acceptedReservationIds.length)
    reasons.push('DUPLICATE_REQUEST_ID');
  if (missingPersistedIds.length > 0) reasons.push('MISSING_PERSISTED_ID');
  if (unexpectedPersistedIds.length > 0)
    reasons.push('UNEXPECTED_PERSISTED_ID');
  if (missingProcessedIds.length > 0) reasons.push('MISSING_PROCESSED_ID');
  if (unexpectedProcessedIds.length > 0)
    reasons.push('UNEXPECTED_PROCESSED_ID');
  if (failedReservationIds.length > 0) reasons.push('TERMINAL_FAILURE');
  if (input.scenario !== 'rebooking' && duplicateSeats.length > 0)
    reasons.push('DUPLICATE_SEAT');
  if (duplicateActiveSeats.length > 0)
    reasons.push('DUPLICATE_ACTIVE_SEAT');
  if (input.foreignQueueMessages > 0) reasons.push('FOREIGN_RUN_MESSAGE');

  if (input.expectedRequests) {
    const expectedRequestIds = sortedUnique(
      Object.keys(input.expectedRequests),
    );
    const actualRequestIds = sortedUnique(
      Object.keys(input.actualRequests || {}),
    );
    const missingRequestIds = difference(expectedRequestIds, actualRequestIds);
    const unexpectedRequestIds = difference(
      actualRequestIds,
      expectedRequestIds,
    );
    const mismatchedRequestIds = [];
    const actualRequestsPerSeat = {};
    for (const requestId of actualRequestIds) {
      const actual = input.actualRequests[requestId];
      if (actual?.seatId) {
        actualRequestsPerSeat[actual.seatId] =
          (actualRequestsPerSeat[actual.seatId] || 0) + 1;
      }
      const expected = input.expectedRequests[requestId];
      if (
        expected &&
        (expected.seatId !== actual?.seatId ||
          expected.userId !== actual?.userId)
      ) {
        mismatchedRequestIds.push(requestId);
      }
    }
    const normalizedExpectedRequestsPerSeat = Object.fromEntries(
      Object.entries(input.expectedRequestsPerSeat).sort(),
    );
    const expectedDistribution = JSON.stringify(
      normalizedExpectedRequestsPerSeat,
    );
    const actualDistribution = JSON.stringify(
      Object.fromEntries(Object.entries(actualRequestsPerSeat).sort()),
    );
    requestAudit = {
      expectedCount: expectedRequestIds.length,
      actualCount: actualRequestIds.length,
      expectedAccepted: input.expectedAccepted,
      actualAccepted: input.summaryAccepted,
      expectedConflicts: input.expectedConflicts,
      actualConflicts: input.summaryConflicts,
      expectedRequestsPerSeat: normalizedExpectedRequestsPerSeat,
      actualRequestsPerSeat: Object.fromEntries(
        Object.entries(actualRequestsPerSeat).sort(),
      ),
      missingRequestIds,
      unexpectedRequestIds,
      mismatchedRequestIds,
    };
    if (actualRequestIds.length !== expectedRequestIds.length)
      reasons.push('REQUEST_ATTEMPT_COUNT_MISMATCH');
    if (missingRequestIds.length > 0) reasons.push('MISSING_REQUEST_ATTEMPT');
    if (unexpectedRequestIds.length > 0)
      reasons.push('UNEXPECTED_REQUEST_ATTEMPT');
    if (mismatchedRequestIds.length > 0)
      reasons.push('REQUEST_ASSIGNMENT_MISMATCH');
    if (expectedDistribution !== actualDistribution)
      reasons.push('REQUEST_DISTRIBUTION_MISMATCH');
    if (input.summaryAccepted !== input.expectedAccepted)
      reasons.push('EXPECTED_ACCEPTED_MISMATCH');
    if (input.summaryConflicts !== input.expectedConflicts)
      reasons.push('EXPECTED_CONFLICT_MISMATCH');
    if (input.summaryIterations !== input.expectedIterations)
      reasons.push('ITERATION_COUNT_MISMATCH');
    if (input.summaryUnexpectedErrors !== 0)
      reasons.push('UNEXPECTED_ERROR_OBSERVED');
    if (input.summaryTimeouts !== 0) reasons.push('TIMEOUT_OBSERVED');
    if (input.cacheProfileState !== input.cacheProfile)
      reasons.push('CACHE_PROFILE_NOT_APPLIED');
    if (counters.attempts !== expectedRequestIds.length)
      reasons.push('REQUEST_ATTEMPT_COUNTER_MISMATCH');
  }

  let rebooking = null;
  if (input.scenario === 'rebooking') {
    const firstRequestId = `${input.runId}-req-first`;
    const secondRequestId = `${input.runId}-req-second`;
    const reservationIdForRequest = (requestId) =>
      Object.entries(input.acceptedMappings).find(
        ([, acceptedRequestId]) => acceptedRequestId === requestId,
      )?.[0] || null;
    const firstReservationId = reservationIdForRequest(firstRequestId);
    const secondReservationId = reservationIdForRequest(secondRequestId);
    const firstReservation = input.db.reservations.find(
      (reservation) => reservation.id === firstReservationId,
    );
    const secondReservation = input.db.reservations.find(
      (reservation) => reservation.id === secondReservationId,
    );
    rebooking = {
      firstRequestId,
      secondRequestId,
      firstReservationId,
      secondReservationId,
      firstStatus: firstReservation?.status || null,
      secondStatus: secondReservation?.status || null,
      finalSeatStatus: input.db.seatStatusById?.[input.db.reservations[0]?.seatId] || null,
      finalRedisStatus: input.redisSeatStatuses?.[input.db.reservations[0]?.seatId] || null,
      historyCount: input.db.reservations.length,
      activeCount: input.db.reservations.filter((reservation) =>
        ['PENDING', 'CONFIRMED'].includes(reservation.status),
      ).length,
    };
    if (!firstReservationId || !secondReservationId)
      reasons.push('REBOOKING_ACCEPTED_ID_MISSING');
    if (firstReservationId === secondReservationId)
      reasons.push('REBOOKING_ID_REUSED');
    if (firstReservation?.status !== 'CANCELLED')
      reasons.push('FIRST_RESERVATION_NOT_CANCELLED');
    if (!['PENDING', 'CONFIRMED'].includes(secondReservation?.status))
      reasons.push('SECOND_RESERVATION_NOT_ACTIVE');
    if (rebooking.activeCount !== 1)
      reasons.push('REBOOKING_ACTIVE_COUNT_MISMATCH');
    if (rebooking.finalSeatStatus !== 'HELD')
      reasons.push('REBOOKING_SEAT_STATUS_MISMATCH');
    if (rebooking.finalRedisStatus !== 'HELD')
      reasons.push('REBOOKING_REDIS_STATUS_MISMATCH');
    if (input.summaryFirstAccepted !== 1)
      reasons.push('FIRST_ACCEPTED_METRIC_MISMATCH');
    if (input.summarySecondAccepted !== 1)
      reasons.push('SECOND_ACCEPTED_METRIC_MISMATCH');
  }

  return {
    schemaVersion: 1,
    runId: input.runId,
    testEnvId: input.testEnvId,
    performanceId: input.performanceId,
    auditedAt: new Date().toISOString(),
    producer: { state: input.producerState },
    drain: input.drain,
    queues: input.queues,
    counters: {
      ...counters,
      conservationDifference,
    },
    database: {
      reservationCount: input.db.reservations.length,
      distinctSeatCount: seatCounts.size,
      duplicateSeats,
      duplicateActiveSeats,
      seatStatusDistribution: input.db.seatStatusDistribution,
      reservationStatusDistribution: input.db.reservationStatusDistribution,
    },
    ids: {
      acceptedRequestIds,
      acceptedReservationIds,
      processedReservationIds,
      persistedReservationIds,
      failedReservationIds,
      missingPersistedIds,
      unexpectedPersistedIds,
      missingProcessedIds,
      unexpectedProcessedIds,
    },
    requestAudit,
    rebooking,
    consistency: {
      pass: reasons.length === 0,
      reasons,
    },
  };
}
