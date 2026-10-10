import { check } from 'k6';

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
import { CAPACITY_ASSIGNMENTS, capacityAssignmentFor } from './capacity.js';
import { requestIdFor } from './consistency.js';
import {
  recordLongRunRequestStarted,
  recordLongRunResponseCompleted,
  recordReservationOutcome,
  requestStartOffset,
  SOAK_WINDOW_COUNT,
} from './metrics.js';

function randomText(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

export function setupLongRun(config, env) {
  if (config.fixtureSeedMode !== 'api-array') {
    throw new Error(
      'chunked-bulk fixture provisioning must complete before an approved remote run',
    );
  }
  const tokens = [];
  const userIds = [];
  const suffix = `${config.runId}-${randomText(10)}`;
  const setupScenario = `${config.scenario}_setup`;

  for (let index = 0; index < config.userCount; index += 1) {
    const credentials = {
      email: `k6-${config.scenario}-${index}-${suffix}@example.invalid`,
      password: `K6-${randomText(24)}-9a`,
      name: `k6-${config.runId}-${index}`,
    };
    const signupBody = parseRequiredObject(
      signup(config.baseUrl, credentials, setupScenario),
      201,
      ['userId'],
      'long-run signup',
    );
    const loginBody = parseRequiredObject(
      login(
        config.baseUrl,
        { email: credentials.email, password: credentials.password },
        setupScenario,
      ),
      200,
      ['accessToken'],
      'long-run login',
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
      setupScenario,
    ),
    201,
    ['id'],
    'long-run event creation',
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
      setupScenario,
    ),
    201,
    ['id'],
    'long-run performance creation',
  );
  const seats = parseRequiredArray(
    getSeats(config.baseUrl, tokens[0], performance.id, setupScenario),
    200,
    ['id'],
    'long-run seat lookup',
  );
  if (seats.length !== config.seatCount) {
    throw new Error('long-run seat lookup count does not match the fixture');
  }
  const seatIds = seats.map((seat) => seat.id);
  parseRequiredObject(
    registerFixture(
      config.baseUrl,
      env.TEST_PREFLIGHT_TOKEN,
      config.runId,
      {
        scenario: config.scenario,
        capacityProfile: 'unique-seat',
        cacheProfile: config.cacheProfile,
        userIds,
        eventId: event.id,
        performanceId: performance.id,
        seatIds,
        requestManifest: {
          schemaVersion: 2,
          requestBudget: config.loadRequestBudget,
          assignment: CAPACITY_ASSIGNMENTS['unique-seat'],
        },
      },
      setupScenario,
    ),
    201,
    ['runId', 'producerState'],
    'long-run fixture registration',
  );
  parseRequiredObject(
    applyCacheProfile(
      config.baseUrl,
      env.TEST_PREFLIGHT_TOKEN,
      config.runId,
      setupScenario,
    ),
    201,
    ['runId', 'cacheProfile', 'seatCount', 'verified'],
    'long-run cache profile',
  );

  return { tokens, userIds, seatIds, performanceId: performance.id };
}

export function executeLongRunIteration(
  config,
  data,
  iteration,
  phase,
  elapsedMs,
) {
  if (iteration >= config.loadRequestBudget) {
    throw new Error(
      'long-run request budget exhausted; increase LOAD_REQUEST_BUDGET',
    );
  }
  const assignment = capacityAssignmentFor(
    iteration,
    data.userIds,
    data.seatIds,
    'unique-seat',
    config.loadRequestBudget,
  );
  const requestId = requestIdFor(config.runId, iteration);
  const tags = { scenario: config.scenario, load_phase: phase };
  const windowIndex =
    config.scenario === 'soak'
      ? Math.min(
          SOAK_WINDOW_COUNT - 1,
          Math.floor((elapsedMs / config.soakDurationMs) * SOAK_WINDOW_COUNT),
        )
      : null;
  requestStartOffset.add(elapsedMs, tags);
  recordLongRunRequestStarted(config.scenario, phase, windowIndex);
  const response = createReservation(
    config.baseUrl,
    data.tokens[iteration % data.tokens.length],
    assignment.seatId,
    config.runId,
    requestId,
    config.scenario,
  );
  const outcome = recordReservationOutcome(response, config.scenario);
  recordLongRunResponseCompleted(
    response,
    outcome,
    config.scenario,
    phase,
    windowIndex,
  );
  check(response, {
    'long-run reservation is accepted': () => outcome === 'accepted',
    'long-run response preserves the immutable request ID': (candidate) => {
      try {
        return candidate.json().requestId === requestId;
      } catch (_) {
        return false;
      }
    },
  });
}

export function teardownLongRun(config, env, data) {
  if (!data || !data.performanceId) return;
  parseRequiredObject(
    completeProducer(
      config.baseUrl,
      env.TEST_PREFLIGHT_TOKEN,
      config.runId,
      `${config.scenario}_teardown`,
    ),
    201,
    ['runId', 'producerState'],
    'long-run producer completion',
  );
}

export function abortingThreshold(threshold, delayAbortEval) {
  return [{ threshold, abortOnFail: true, delayAbortEval }];
}
