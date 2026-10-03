import { check } from 'k6';
import exec from 'k6/execution';

import {
  createEvent,
  createPerformance,
  createReservation,
  completeProducer,
  getSeats,
  login,
  parseRequiredArray,
  parseRequiredObject,
  signup,
  registerFixture,
} from '../lib/api.js';
import { loadConfig } from '../lib/config.js';
import { recordReservationOutcome } from '../lib/metrics.js';
import { createHandleSummary } from '../lib/summary.js';

const inspectConfig = loadConfig(__ENV);

export const options = {
  rps: inspectConfig.rps,
  scenarios: {
    smoke: {
      executor: 'per-vu-iterations',
      vus: inspectConfig.vus,
      iterations: 1,
      maxDuration: inspectConfig.duration,
      gracefulStop: '1s',
      tags: { scenario: 'smoke' },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    unexpected_error: ['count==0'],
    timeout: ['count==0'],
  },
  discardResponseBodies: false,
};

function randomText(length) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return value;
}

export function setup() {
  const config = loadConfig(__ENV, { requireExecution: true });
  const tokens = [];
  const userIds = [];
  const fixtureSuffix = `${config.runId}-${randomText(10)}`;

  for (let index = 0; index < config.userCount; index += 1) {
    const credentials = {
      email: `k6-${index}-${fixtureSuffix}@example.invalid`,
      password: `K6-${randomText(24)}-9a`,
      name: `k6-${config.runId}-${index}`,
    };
    const signupBody = parseRequiredObject(
      signup(config.baseUrl, credentials),
      201,
      ['userId'],
      'signup',
    );
    const loginBody = parseRequiredObject(
      login(config.baseUrl, {
        email: credentials.email,
        password: credentials.password,
      }),
      200,
      ['accessToken'],
      'login',
    );
    userIds.push(signupBody.userId);
    tokens.push(loginBody.accessToken);
  }

  const eventBody = parseRequiredObject(
    createEvent(config.baseUrl, tokens[0], {
      title: `k6-smoke-${fixtureSuffix}`,
      description: `Run ${config.runId}`,
    }),
    201,
    ['id'],
    'event creation',
  );
  const performanceBody = parseRequiredObject(
    createPerformance(config.baseUrl, tokens[0], eventBody.id, {
      startAt: new Date(Date.now() + 86400000).toISOString(),
      totalSeats: config.seatCount,
      availableSeats: config.seatCount,
    }),
    201,
    ['id'],
    'performance creation',
  );
  const seats = parseRequiredArray(
    getSeats(config.baseUrl, tokens[0], performanceBody.id),
    200,
    ['id'],
    'seat lookup',
  );
  if (seats.length < config.vus) {
    throw new Error('seat lookup returned fewer seats than configured VUs');
  }

  parseRequiredObject(
    registerFixture(config.baseUrl, __ENV.TEST_PREFLIGHT_TOKEN, config.runId, {
      userIds,
      eventId: eventBody.id,
      performanceId: performanceBody.id,
      seatIds: seats.map((seat) => seat.id),
    }),
    201,
    ['runId', 'producerState'],
    'fixture registration',
  );

  return {
    tokens,
    userIds,
    eventId: eventBody.id,
    performanceId: performanceBody.id,
    seatIds: seats.map((seat) => seat.id),
  };
}

export default function (data) {
  const index = (exec.vu.idInTest - 1) % data.seatIds.length;
  const token = data.tokens[index % data.tokens.length];
  const requestId = `${inspectConfig.runId}-req-${exec.scenario.iterationInTest}`;
  const response = createReservation(
    inspectConfig.baseUrl,
    token,
    data.seatIds[index],
    inspectConfig.runId,
    requestId,
  );
  const outcome = recordReservationOutcome(response);

  check(response, {
    'smoke reservation is accepted': () => outcome === 'accepted',
    'accepted response has matching identifiers': (candidate) => {
      if (candidate.status !== 201) return false;
      try {
        const body = candidate.json();
        return Boolean(
          body &&
          body.code === 'RESERVATION_ACCEPTED' &&
          body.status === 'PENDING' &&
          body.id &&
          body.requestId === requestId,
        );
      } catch (_) {
        return false;
      }
    },
  });
}

export function teardown(data) {
  if (!data || !data.performanceId) return;
  parseRequiredObject(
    completeProducer(
      inspectConfig.baseUrl,
      __ENV.TEST_PREFLIGHT_TOKEN,
      inspectConfig.runId,
    ),
    201,
    ['runId', 'producerState'],
    'producer completion',
  );
}

export const handleSummary = createHandleSummary(inspectConfig);
