import { check, sleep } from 'k6';

import {
  cancelReservation,
  createReservation,
  parseRequiredObject,
} from '../lib/api.js';
import { loadConfig } from '../lib/config.js';
import {
  setupConsistency,
  teardownConsistency,
} from '../lib/consistency-scenario.js';
import {
  rebookingFirstAccepted,
  rebookingSecondAccepted,
  recordReservationOutcome,
  requestStartOffset,
} from '../lib/metrics.js';
import { createHandleSummary } from '../lib/summary.js';

const config = loadConfig(__ENV, { scenario: 'rebooking' });

export const options = {
  scenarios: {
    rebooking: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: config.duration,
      gracefulStop: '1s',
      tags: { scenario: config.scenario, cache_profile: config.cacheProfile },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    accepted: ['count==2'],
    rebooking_first_accepted: ['count==1'],
    rebooking_second_accepted: ['count==1'],
    expected_conflict: ['count==0'],
    unexpected_error: ['count==0'],
    timeout: ['count==0'],
    iterations: ['count==1'],
  },
  setupTimeout: '10m',
  discardResponseBodies: false,
};

export function setup() {
  return setupConsistency(
    loadConfig(__ENV, { requireExecution: true, scenario: config.scenario }),
    __ENV.TEST_PREFLIGHT_TOKEN,
  );
}

function acceptedBody(response, requestId, label) {
  const body = parseRequiredObject(
    response,
    201,
    ['id', 'seatId', 'status', 'requestId'],
    label,
  );
  if (
    body.status !== 'PENDING' ||
    body.requestId !== requestId ||
    body.seatId === undefined
  ) {
    throw new Error(`${label} returned an invalid accepted contract`);
  }
  return body;
}

export default function (data) {
  const token = data.tokens[0];
  const seatId = data.seatIds[0];
  const firstRequestId = `${config.runId}-req-first`;
  const secondRequestId = `${config.runId}-req-second`;
  requestStartOffset.add(Date.now() - data.loadEpochMs, {
    scenario: config.scenario,
  });

  const firstResponse = createReservation(
    config.baseUrl,
    token,
    seatId,
    config.runId,
    firstRequestId,
    config.scenario,
  );
  const firstOutcome = recordReservationOutcome(firstResponse, config.scenario);
  if (firstOutcome === 'accepted') {
    rebookingFirstAccepted.add(1, { scenario: config.scenario });
  }
  const first = acceptedBody(
    firstResponse,
    firstRequestId,
    'first reservation',
  );

  let cancellationResponse;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    cancellationResponse = cancelReservation(
      config.baseUrl,
      token,
      first.id,
      config.scenario,
    );
    if (cancellationResponse.status === 200) break;
    if (cancellationResponse.status !== 404) break;
    sleep(0.1);
  }
  const cancelled = parseRequiredObject(
    cancellationResponse,
    200,
    ['id', 'seatId', 'status'],
    'reservation cancellation',
  );

  const secondResponse = createReservation(
    config.baseUrl,
    token,
    seatId,
    config.runId,
    secondRequestId,
    config.scenario,
  );
  const secondOutcome = recordReservationOutcome(
    secondResponse,
    config.scenario,
  );
  if (secondOutcome === 'accepted') {
    rebookingSecondAccepted.add(1, { scenario: config.scenario });
  }
  const second = acceptedBody(
    secondResponse,
    secondRequestId,
    'second reservation',
  );

  check(
    { first, cancelled, second },
    {
      'first reservation is cancelled before rebooking': (state) =>
        state.cancelled.id === state.first.id &&
        state.cancelled.status === 'CANCELLED',
      'rebooking uses a distinct accepted reservation ID': (state) =>
        state.second.id !== state.first.id && state.second.seatId === seatId,
    },
  );
}

export function teardown(data) {
  teardownConsistency(config, __ENV.TEST_PREFLIGHT_TOKEN, data);
}

export const handleSummary = createHandleSummary(config);
