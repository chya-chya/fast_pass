import { check, sleep } from 'k6';
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
  capacityStageIndex,
  capacityStageWindows,
} from '../lib/capacity.js';
import { loadConfig } from '../lib/config.js';
import { requestIdFor } from '../lib/consistency.js';
import {
  recordCapacityOutcome,
  recordReservationOutcome,
  requestStartOffset,
} from '../lib/metrics.js';
import { createHandleSummary } from '../lib/summary.js';

const config = loadConfig(__ENV, { scenario: 'capacity-vu' });
const stageWindows = capacityStageWindows(
  config.capacityTargets,
  config.capacityStageHoldMs,
  config.capacityRampDurationMs,
);
const stages = config.capacityTargets.flatMap((target, index) => [
  { duration: config.capacityRampDuration, target },
  { duration: config.capacityStageHolds[index], target },
]);
stages.push({ duration: config.capacityRampDuration, target: 0 });

export const options = {
  scenarios: {
    capacity_vu: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages,
      gracefulRampDown: '0s',
      tags: {
        scenario: config.scenario,
        capacity_profile: config.capacityProfile,
      },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    accepted_duration_ms: ['p(95)<200', 'p(99)<500'],
    expected_conflict_duration_ms: ['p(95)<200', 'p(99)<500'],
    unexpected_error_duration_ms: ['p(95)<500', 'p(99)<1000'],
    unexpected_error: ['count==0'],
    timeout: ['count==0'],
  },
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
    scenario: 'capacity-vu',
  });
  const tokens = [];
  const userIds = [];
  const suffix = `${executionConfig.runId}-${randomText(10)}`;
  const setupScenario = `${executionConfig.scenario}_setup`;

  for (let index = 0; index < executionConfig.userCount; index += 1) {
    const credentials = {
      email: `k6-capacity-${index}-${suffix}@example.invalid`,
      password: `K6-${randomText(24)}-9a`,
      name: `k6-${executionConfig.runId}-${index}`,
    };
    const signupBody = parseRequiredObject(
      signup(executionConfig.baseUrl, credentials, setupScenario),
      201,
      ['userId'],
      'capacity signup',
    );
    const loginBody = parseRequiredObject(
      login(
        executionConfig.baseUrl,
        { email: credentials.email, password: credentials.password },
        setupScenario,
      ),
      200,
      ['accessToken'],
      'capacity login',
    );
    userIds.push(signupBody.userId);
    tokens.push(loginBody.accessToken);
  }

  const event = parseRequiredObject(
    createEvent(
      executionConfig.baseUrl,
      tokens[0],
      {
        title: `k6-capacity-${executionConfig.capacityProfile}-${suffix}`,
        description: `Run ${executionConfig.runId}`,
      },
      setupScenario,
    ),
    201,
    ['id'],
    'capacity event creation',
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
    'capacity performance creation',
  );
  const seats = parseRequiredArray(
    getSeats(executionConfig.baseUrl, tokens[0], performance.id, setupScenario),
    200,
    ['id'],
    'capacity seat lookup',
  );
  if (seats.length !== executionConfig.seatCount) {
    throw new Error('capacity seat lookup count does not match the fixture');
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
        userBehavior: executionConfig.capacityUserBehavior,
        thinkTimeMs: executionConfig.capacityThinkTimeMs,
        userIds,
        eventId: event.id,
        performanceId: performance.id,
        seatIds,
        requestManifest: {
          schemaVersion: 2,
          requestBudget: executionConfig.capacityRequestBudget,
          assignment: CAPACITY_ASSIGNMENTS[executionConfig.capacityProfile],
        },
      },
      setupScenario,
    ),
    201,
    ['runId', 'producerState'],
    'capacity fixture registration',
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
    'capacity cache profile',
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
  if (iteration >= config.capacityRequestBudget) {
    exec.test.abort(
      'capacity request budget exhausted; increase CAPACITY_REQUEST_BUDGET before rerunning',
    );
  }
  if (config.capacityUserBehavior === 'think-then-reserve') {
    sleep(config.capacityThinkTimeMs / 1000);
  }

  const assignment = capacityAssignmentFor(
    iteration,
    data.userIds,
    data.seatIds,
    config.capacityProfile,
    config.capacityRequestBudget,
  );
  const requestId = requestIdFor(config.runId, iteration);
  const elapsedMs = Math.max(0, Date.now() - Number(exec.scenario.startTime));
  const stageIndex = capacityStageIndex(elapsedMs, stageWindows);
  requestStartOffset.add(elapsedMs, {
    scenario: config.scenario,
    capacity_profile: config.capacityProfile,
    capacity_stage: String(stageIndex + 1),
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
  recordCapacityOutcome(response, outcome, config.capacityProfile, stageIndex);

  check(response, {
    'capacity outcome matches the isolated profile': () =>
      config.capacityProfile === 'unique-seat'
        ? outcome === 'accepted'
        : outcome === 'accepted' || outcome === 'expected_conflict',
    'capacity response preserves the immutable request ID': (candidate) => {
      try {
        return candidate.json().requestId === requestId;
      } catch (_) {
        return false;
      }
    },
  });

  if (config.capacityUserBehavior === 'reserve-then-think') {
    sleep(config.capacityThinkTimeMs / 1000);
  }
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
    'capacity producer completion',
  );
}

export const handleSummary = createHandleSummary(config);
