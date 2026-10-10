import { Counter, Rate, Trend } from 'k6/metrics';
import { classifyReservationResponse } from './classification.js';

export const accepted = new Counter('accepted');
export const expectedConflict = new Counter('expected_conflict');
export const unexpectedError = new Counter('unexpected_error');
export const timeout = new Counter('timeout');
export const unexpectedErrorRate = new Rate('unexpected_error_rate');
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
export const reservationRequestsStarted = new Counter(
  'reservation_requests_started',
);
export const reservationResponsesCompleted = new Counter(
  'reservation_responses_completed',
);
export const rpsStageRequestsStarted = [1, 2, 3, 4].map(
  (stage) => new Counter(`rps_stage_${stage}_requests_started`),
);
export const rpsStageResponsesCompleted = [1, 2, 3, 4].map(
  (stage) => new Counter(`rps_stage_${stage}_responses_completed`),
);
export const loadRequestsStarted = new Counter('load_requests_started');
export const loadResponsesCompleted = new Counter('load_responses_completed');
const LONG_RUN_PHASES = Object.freeze([
  'spike_baseline',
  'spike_peak',
  'spike_recovery',
  'soak',
]);
export const longRunPhaseMetrics = Object.freeze(
  Object.fromEntries(
    LONG_RUN_PHASES.map((phase) => [
      phase,
      Object.freeze({
        started: new Counter(`${phase}_requests_started`),
        completed: new Counter(`${phase}_responses_completed`),
        acceptedDuration: new Trend(`${phase}_accepted_duration_ms`, true),
        unexpectedError: new Counter(`${phase}_unexpected_error`),
        timeout: new Counter(`${phase}_timeout`),
      }),
    ]),
  ),
);
export const SOAK_WINDOW_COUNT = 6;
export const soakWindowMetrics = Object.freeze(
  Array.from({ length: SOAK_WINDOW_COUNT }, (_, index) => {
    const prefix = `soak_window_${index + 1}`;
    return Object.freeze({
      started: new Counter(`${prefix}_requests_started`),
      completed: new Counter(`${prefix}_responses_completed`),
      acceptedDuration: new Trend(`${prefix}_accepted_duration_ms`, true),
      unexpectedError: new Counter(`${prefix}_unexpected_error`),
      timeout: new Counter(`${prefix}_timeout`),
    });
  }),
);

export function recordReservationOutcome(response, scenario = 'smoke') {
  const outcome = classifyReservationResponse(response);
  const tags = { endpoint: 'reservation_create', scenario, outcome };

  if (response && response.tags) response.tags.outcome = outcome;
  if (outcome === 'accepted') accepted.add(1, tags);
  if (outcome === 'expected_conflict') expectedConflict.add(1, tags);
  if (outcome === 'unexpected_error') unexpectedError.add(1, tags);
  if (outcome === 'timeout') timeout.add(1, tags);
  unexpectedErrorRate.add(outcome === 'unexpected_error', tags);
  return outcome;
}

function longRunMetricKey(scenario, phase) {
  return scenario === 'soak' ? 'soak' : `spike_${phase}`;
}

export function recordLongRunRequestStarted(scenario, phase, windowIndex) {
  const metricKey = longRunMetricKey(scenario, phase);
  const metric = longRunPhaseMetrics[metricKey];
  if (!metric) throw new Error('long-run phase metric is unavailable');
  const tags = { scenario, load_phase: phase };
  loadRequestsStarted.add(1, tags);
  metric.started.add(1, tags);
  if (scenario === 'soak') soakWindowMetrics[windowIndex].started.add(1, tags);
}

export function recordLongRunResponseCompleted(
  response,
  outcome,
  scenario,
  phase,
  windowIndex,
) {
  const metricKey = longRunMetricKey(scenario, phase);
  const metric = longRunPhaseMetrics[metricKey];
  if (!metric) throw new Error('long-run phase metric is unavailable');
  const tags = { scenario, load_phase: phase, outcome };
  loadResponsesCompleted.add(1, tags);
  metric.completed.add(1, tags);
  if (outcome === 'unexpected_error') metric.unexpectedError.add(1, tags);
  if (outcome === 'timeout') metric.timeout.add(1, tags);
  const soakWindow =
    scenario === 'soak' ? soakWindowMetrics[windowIndex] : null;
  if (soakWindow) {
    soakWindow.completed.add(1, tags);
    if (outcome === 'unexpected_error') soakWindow.unexpectedError.add(1, tags);
    if (outcome === 'timeout') soakWindow.timeout.add(1, tags);
  }
  const duration = Number(response?.timings?.duration);
  if (Number.isFinite(duration) && outcome === 'accepted') {
    metric.acceptedDuration.add(duration, tags);
    if (soakWindow) soakWindow.acceptedDuration.add(duration, tags);
  }
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

export function recordRpsRequestStarted(testProfile, dataProfile, stageIndex) {
  const tags = {
    endpoint: 'reservation_create',
    scenario: 'capacity-rps',
    rps_test_profile: testProfile,
    capacity_profile: dataProfile,
    rps_stage: String(stageIndex + 1),
  };
  reservationRequestsStarted.add(1, tags);
  rpsStageRequestsStarted[stageIndex].add(1, tags);
}

export function recordRpsResponseCompleted(
  response,
  outcome,
  testProfile,
  dataProfile,
  stageIndex,
) {
  const tags = {
    endpoint: 'reservation_create',
    scenario: 'capacity-rps',
    rps_test_profile: testProfile,
    capacity_profile: dataProfile,
    outcome,
    rps_stage: String(stageIndex + 1),
  };
  const duration = Number(response?.timings?.duration);
  reservationResponsesCompleted.add(1, tags);
  rpsStageResponsesCompleted[stageIndex].add(1, tags);
  if (!Number.isFinite(duration)) return;
  if (outcome === 'accepted') acceptedDuration.add(duration, tags);
  if (outcome === 'expected_conflict') {
    expectedConflictDuration.add(duration, tags);
  }
  if (outcome === 'unexpected_error') {
    unexpectedErrorDuration.add(duration, tags);
  }
  if (outcome === 'timeout') timeoutDuration.add(duration, tags);
}
