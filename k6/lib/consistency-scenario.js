import { check } from 'k6';
import exec from 'k6/execution';

import {
  applyCacheProfile,
  completeProducer,
  createEvent,
  createPerformance,
  createReservation,
  getSeats,
  login,
  parseRequiredArray,
  parseRequiredObject,
  registerFixture,
  signup,
} from './api.js';
import {
  assignmentFor,
  REBOOKING_ASSIGNMENT,
  REQUEST_ASSIGNMENT,
  requestIdFor,
} from './consistency.js';
import { recordReservationOutcome, requestStartOffset } from './metrics.js';

function randomText(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

export function setupConsistency(config, preflightToken) {
  const tokens = [];
  const userIds = [];
  const suffix = `${config.runId}-${randomText(10)}`;
  for (let index = 0; index < config.userCount; index += 1) {
    const credentials = {
      email: `k6-${index}-${suffix}@example.invalid`,
      password: `K6-${randomText(24)}-9a`,
      name: `k6-${config.runId}-${index}`,
    };
    const signupBody = parseRequiredObject(
      signup(config.baseUrl, credentials, `${config.scenario}_setup`),
      201,
      ['userId'],
      'signup',
    );
    const loginBody = parseRequiredObject(
      login(
        config.baseUrl,
        { email: credentials.email, password: credentials.password },
        `${config.scenario}_setup`,
      ),
      200,
      ['accessToken'],
      'login',
    );
    userIds.push(signupBody.userId);
    tokens.push(loginBody.accessToken);
  }

  const event = parseRequiredObject(
    createEvent(
      config.baseUrl,
      tokens[0],
      {
        title: `k6-${config.scenario}-${suffix}`,
        description: `Run ${config.runId}`,
      },
      `${config.scenario}_setup`,
    ),
    201,
    ['id'],
    'event creation',
  );
  const performance = parseRequiredObject(
    createPerformance(
      config.baseUrl,
      tokens[0],
      event.id,
      {
        startAt: new Date(Date.now() + 86400000).toISOString(),
        totalSeats: config.seatCount,
        availableSeats: config.seatCount,
      },
      `${config.scenario}_setup`,
    ),
    201,
    ['id'],
    'performance creation',
  );
  const seats = parseRequiredArray(
    getSeats(
      config.baseUrl,
      tokens[0],
      performance.id,
      `${config.scenario}_setup`,
    ),
    200,
    ['id'],
    'seat lookup',
  );
  if (seats.length !== config.seatCount) {
    throw new Error('seat lookup count does not match the immutable dataset');
  }
  const seatIds = seats.map((seat) => seat.id);
  parseRequiredObject(
    registerFixture(
      config.baseUrl,
      preflightToken,
      config.runId,
      {
        scenario: config.scenario,
        cacheProfile: config.cacheProfile,
        userIds,
        eventId: event.id,
        performanceId: performance.id,
        seatIds,
        requestManifest: {
          schemaVersion: 1,
          totalRequests: config.totalRequests,
          assignment:
            config.scenario === 'rebooking'
              ? REBOOKING_ASSIGNMENT
              : REQUEST_ASSIGNMENT,
        },
      },
      `${config.scenario}_setup`,
    ),
    201,
    ['runId', 'producerState'],
    'fixture registration',
  );
  parseRequiredObject(
    applyCacheProfile(
      config.baseUrl,
      preflightToken,
      config.runId,
      `${config.scenario}_setup`,
    ),
    201,
    ['runId', 'cacheProfile', 'seatCount', 'verified'],
    'cache profile',
  );
  return {
    tokens,
    userIds,
    seatIds,
    performanceId: performance.id,
    loadEpochMs: Date.now(),
  };
}

export function executeConsistency(config, data) {
  const iteration = exec.scenario.iterationInTest;
  const assignment = assignmentFor(iteration, data.userIds, data.seatIds);
  const requestId = requestIdFor(config.runId, iteration);
  requestStartOffset.add(Date.now() - data.loadEpochMs, {
    scenario: config.scenario,
  });
  const response = createReservation(
    config.baseUrl,
    data.tokens[iteration % data.tokens.length],
    assignment.seatId,
    config.runId,
    requestId,
    config.scenario,
  );
  const outcome = recordReservationOutcome(response, config.scenario);
  check(response, {
    'reservation outcome is accepted or expected conflict': () =>
      outcome === 'accepted' || outcome === 'expected_conflict',
    'response correlation matches immutable request ID': (candidate) => {
      try {
        return candidate.json().requestId === requestId;
      } catch (_) {
        return false;
      }
    },
  });
}

export function teardownConsistency(config, preflightToken, data) {
  if (!data || !data.performanceId) return;
  parseRequiredObject(
    completeProducer(
      config.baseUrl,
      preflightToken,
      config.runId,
      `${config.scenario}_teardown`,
    ),
    201,
    ['runId', 'producerState'],
    'producer completion',
  );
}
