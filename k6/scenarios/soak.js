import exec from 'k6/execution';

import { loadConfig } from '../lib/config.js';
import {
  abortingThreshold,
  executeLongRunIteration,
  setupLongRun,
  teardownLongRun,
} from '../lib/long-run.js';
import { createHandleSummary } from '../lib/summary.js';
import { SOAK_WINDOW_COUNT } from '../lib/metrics.js';

const config = loadConfig(__ENV, { scenario: 'soak' });
const abortDelay = `${Math.max(
  1,
  Math.ceil(
    (config.watchdogPollIntervalMs * config.watchdogConsecutiveViolations) /
      1000,
  ),
)}s`;

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate: config.soakRps,
      timeUnit: config.loadTimeUnit,
      duration: config.soakDuration,
      preAllocatedVUs: config.loadPreAllocatedVus,
      maxVUs: config.loadMaxVus,
      gracefulStop: '30s',
      tags: { scenario: config.scenario, load_phase: 'soak' },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    unexpected_error_rate: abortingThreshold('rate<0.001', abortDelay),
    dropped_iterations: abortingThreshold('count==0', abortDelay),
    soak_accepted_duration_ms: ['p(95)<200', 'p(99)<500'],
    soak_unexpected_error: ['count==0'],
    soak_timeout: ['count==0'],
    ...Object.fromEntries(
      Array.from({ length: SOAK_WINDOW_COUNT }, (_, index) => [
        `soak_window_${index + 1}_accepted_duration_ms`,
        ['p(95)<200', 'p(99)<500'],
      ]),
    ),
  },
  setupTimeout: config.loadSetupAllowance,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  discardResponseBodies: false,
};

export function setup() {
  return setupLongRun(
    loadConfig(__ENV, { requireExecution: true, scenario: 'soak' }),
    __ENV,
  );
}

export default function (data) {
  const iteration = exec.scenario.iterationInTest;
  const elapsedMs = Math.max(0, Date.now() - Number(exec.scenario.startTime));
  executeLongRunIteration(config, data, iteration, 'soak', elapsedMs);
}

export function teardown(data) {
  teardownLongRun(config, __ENV, data);
}

export const handleSummary = createHandleSummary(config);
