import { Counter, Trend } from 'k6/metrics';
import { classifyReservationResponse } from './classification.js';

export const accepted = new Counter('accepted');
export const expectedConflict = new Counter('expected_conflict');
export const unexpectedError = new Counter('unexpected_error');
export const timeout = new Counter('timeout');
export const requestStartOffset = new Trend('request_start_offset_ms', true);
export const rebookingFirstAccepted = new Counter('rebooking_first_accepted');
export const rebookingSecondAccepted = new Counter('rebooking_second_accepted');

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
