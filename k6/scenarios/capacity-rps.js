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
} from '../lib/api.js';
import {
  CAPACITY_ASSIGNMENTS,
  capacityAssignmentFor,
} from '../lib/capacity.js';
import { loadConfig } from '../lib/config.js';
import { requestIdFor } from '../lib/consistency.js';
import {
  recordReservationOutcome,
  recordRpsRequestStarted,
  recordRpsResponseCompleted,
  requestStartOffset,
} from '../lib/metrics.js';
import { rpsStageIndex, rpsStageWindows } from '../lib/rps.js';
import { createHandleSummary } from '../lib/summary.js';

const config = loadConfig(__ENV, { scenario: 'capacity-rps' });
const exploration = config.rpsTestProfile === 'explore';
const stableConfirmation = ['confirm-50', 'confirm-75', 'confirm-100'].includes(
  config.rpsTestProfile,
);
const stageWindows = exploration
  ? rpsStageWindows(
      config.rpsTargets,
      config.rpsStageHoldMs,
      config.rpsRampDurationMs,
    )
  : [
      {
        index: 0,
        target: config.rpsRate,
        startedAtMs: 0,
        endedAtMs: config.rpsLoadDurationMs,
        durationMs: config.rpsLoadDurationMs,
      },
    ];
const explorationStages = config.rpsTargets.flatMap((target, index) => [
  { duration: config.rpsRampDuration, target },
  { duration: config.rpsStageHolds[index], target },
]);
explorationStages.push({ duration: config.rpsRampDuration, target: 0 });

const scenarioOptions = exploration
  ? {
      executor: 'ramping-arrival-rate',
      startRate: 0,
      timeUnit: config.rpsTimeUnit,
      preAllocatedVUs: config.rpsPreAllocatedVus,
      maxVUs: config.rpsMaxVus,
      stages: explorationStages,
    }
  : {
      executor: 'constant-arrival-rate',
      rate: config.rpsRate,
      timeUnit: config.rpsTimeUnit,
      duration: config.rpsConfirmationDuration,
      preAllocatedVUs: config.rpsPreAllocatedVus,
      maxVUs: config.rpsMaxVus,
    };

const thresholds = {
  checks: ['rate==1'],
  accepted_duration_ms: ['p(95)<200', 'p(99)<500'],
  expected_conflict_duration_ms: ['p(95)<200', 'p(99)<500'],
  unexpected_error_duration_ms: ['p(95)<500', 'p(99)<1000'],
  unexpected_error: ['count==0'],
  timeout: ['count==0'],
};
if (stableConfirmation) thresholds.dropped_iterations = ['count==0'];

export const options = {
  scenarios: {
    capacity_rps: {
      ...scenarioOptions,
      gracefulStop: '30s',
      tags: {
        scenario: config.scenario,
        rps_test_profile: config.rpsTestProfile,
        capacity_profile: config.capacityProfile,
      },
    },
  },
  thresholds,
  setupTimeout: '60m',
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
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
  const executionConfig = loadConfig(__ENV, {
    requireExecution: true,
    scenario: 'capacity-rps',
  });
  const tokens = [];
  const userIds = [];
  const suffix = `${executionConfig.runId}-${randomText(10)}`;
  const setupScenario = `${executionConfig.scenario}_setup`;

  for (let index = 0; index < executionConfig.userCount; index += 1) {
    const credentials = {
      email: `k6-rps-${index}-${suffix}@example.invalid`,
      password: `K6-${randomText(24)}-9a`,
      name: `k6-${executionConfig.runId}-${index}`,
    };
    const signupBody = parseRequiredObject(
      signup(executionConfig.baseUrl, credentials, setupScenario),
      201,
      ['userId'],
      'RPS signup',
    );
    const loginBody = parseRequiredObject(
      login(
        executionConfig.baseUrl,
        { email: credentials.email, password: credentials.password },
        setupScenario,
      ),
      200,
      ['accessToken'],
      'RPS login',
    );
    userIds.push(signupBody.userId);
    tokens.push(loginBody.accessToken);
  }

  const event = parseRequiredObject(
    createEvent(
      executionConfig.baseUrl,
      tokens[0],
      {
        title: `k6-rps-${executionConfig.rpsTestProfile}-${executionConfig.capacityProfile}-${suffix}`,
        description: `Run ${executionConfig.runId}`,
      },
      setupScenario,
    ),
    201,
    ['id'],
    'RPS event creation',
  );
  const performance = parseRequiredObject(
    createPerformance(
      executionConfig.baseUrl,
      tokens[0],
      event.id,
      {
        startAt: new Date(Date.now() + 86400000).toISOString(),
        totalSeats: executionConfig.seatCount,
        availableSeats: executionConfig.seatCount,
      },
      setupScenario,
    ),
    201,
    ['id'],
    'RPS performance creation',
  );
  const seats = parseRequiredArray(
    getSeats(executionConfig.baseUrl, tokens[0], performance.id, setupScenario),
    200,
    ['id'],
    'RPS seat lookup',
  );
  if (seats.length !== executionConfig.seatCount) {
    throw new Error('RPS seat lookup count does not match the fixture');
  }
  const seatIds = seats.map((seat) => seat.id);
  parseRequiredObject(
    registerFixture(
      executionConfig.baseUrl,
      __ENV.TEST_PREFLIGHT_TOKEN,
      executionConfig.runId,
      {
        scenario: executionConfig.scenario,
        capacityProfile: executionConfig.capacityProfile,
        cacheProfile: executionConfig.cacheProfile,
        userIds,
        eventId: event.id,
        performanceId: performance.id,
        seatIds,
        requestManifest: {
          schemaVersion: 2,
          requestBudget: executionConfig.rpsRequestBudget,
          assignment: CAPACITY_ASSIGNMENTS[executionConfig.capacityProfile],
        },
      },
      setupScenario,
    ),
    201,
    ['runId', 'producerState'],
    'RPS fixture registration',
  );
  parseRequiredObject(
    applyCacheProfile(
      executionConfig.baseUrl,
      __ENV.TEST_PREFLIGHT_TOKEN,
      executionConfig.runId,
      setupScenario,
    ),
    201,
    ['runId', 'cacheProfile', 'seatCount', 'verified'],
    'RPS cache profile',
  );

  return {
    tokens,
    userIds,
    seatIds,
    performanceId: performance.id,
  };
}

export default function (data) {
  const iteration = exec.scenario.iterationInTest;
  if (iteration >= config.rpsRequestBudget) {
    exec.test.abort(
      'RPS request budget exhausted; increase RPS_REQUEST_BUDGET before rerunning',
    );
  }
  const assignment = capacityAssignmentFor(
    iteration,
    data.userIds,
    data.seatIds,
    config.capacityProfile,
    config.rpsRequestBudget,
  );
  const requestId = requestIdFor(config.runId, iteration);
  const elapsedMs = Math.max(0, Date.now() - Number(exec.scenario.startTime));
  const stageIndex = exploration ? rpsStageIndex(elapsedMs, stageWindows) : 0;
  const metricTags = {
    scenario: config.scenario,
    rps_test_profile: config.rpsTestProfile,
    capacity_profile: config.capacityProfile,
    rps_stage: String(stageIndex + 1),
  };
  requestStartOffset.add(elapsedMs, metricTags);
  recordRpsRequestStarted(
    config.rpsTestProfile,
    config.capacityProfile,
    stageIndex,
  );
  const response = createReservation(
    config.baseUrl,
    data.tokens[iteration % data.tokens.length],
    assignment.seatId,
    config.runId,
    requestId,
    config.scenario,
  );
  const outcome = recordReservationOutcome(response, config.scenario);
  recordRpsResponseCompleted(
    response,
    outcome,
    config.rpsTestProfile,
    config.capacityProfile,
    stageIndex,
  );

  check(response, {
    'RPS outcome matches the isolated data profile': () =>
      config.capacityProfile === 'unique-seat'
        ? outcome === 'accepted'
        : outcome === 'accepted' || outcome === 'expected_conflict',
    'RPS response preserves the immutable request ID': (candidate) => {
      try {
        return candidate.json().requestId === requestId;
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
      config.baseUrl,
      __ENV.TEST_PREFLIGHT_TOKEN,
      config.runId,
      `${config.scenario}_teardown`,
    ),
    201,
    ['runId', 'producerState'],
    'RPS producer completion',
  );
}

export const handleSummary = createHandleSummary(config);
