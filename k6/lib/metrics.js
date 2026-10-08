import { Counter, Trend } from 'k6/metrics';
import { classifyReservationResponse } from './classification.js';

export const accepted = new Counter('accepted');
export const expectedConflict = new Counter('expected_conflict');
export const unexpectedError = new Counter('unexpected_error');
export const timeout = new Counter('timeout');
export const requestStartOffset = new Trend('request_start_offset_ms', true);
export const rebookingFirstAccepted = new Counter('rebooking_first_accepted');
export const rebookingSecondAccepted = new Counter('rebooking_second_accepted');
export const reservationRequests = new Counter('reservation_requests');
export const acceptedDuration = new Trend('accepted_duration_ms', true);
export const expectedConflictDuration = new Trend(
  'expected_conflict_duration_ms',
  true,
);
export const unexpectedErrorDuration = new Trend(
  'unexpected_error_duration_ms',
  true,
);
export const timeoutDuration = new Trend('timeout_duration_ms', true);
export const capacityStageRequests = [1, 2, 3, 4].map(
  (stage) => new Counter(`capacity_stage_${stage}_requests`),
);

export function recordReservationOutcome(response, scenario = 'smoke') {
  const outcome = classifyReservationResponse(response);
  const tags = { endpoint: 'reservation_create', scenario, outcome };

  if (response && response.tags) response.tags.outcome = outcome;
  if (outcome === 'accepted') accepted.add(1, tags);
  if (outcome === 'expected_conflict') expectedConflict.add(1, tags);
  if (outcome === 'unexpected_error') unexpectedError.add(1, tags);
  if (outcome === 'timeout') timeout.add(1, tags);
  return outcome;
}

export function recordCapacityOutcome(response, outcome, profile, stageIndex) {
  const tags = {
    endpoint: 'reservation_create',
    scenario: 'capacity-vu',
    capacity_profile: profile,
    outcome,
    capacity_stage: String(stageIndex + 1),
  };
  const duration = Number(response?.timings?.duration);
  reservationRequests.add(1, tags);
  capacityStageRequests[stageIndex].add(1, tags);
  if (!Number.isFinite(duration)) return;
  if (outcome === 'accepted') acceptedDuration.add(duration, tags);
  if (outcome === 'expected_conflict') {
    expectedConflictDuration.add(duration, tags);
  }
  if (outcome === 'unexpected_error')
    unexpectedErrorDuration.add(duration, tags);
  if (outcome === 'timeout') timeoutDuration.add(duration, tags);
}
