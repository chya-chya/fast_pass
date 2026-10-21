import exec from 'k6/execution';

import { loadConfig } from '../lib/config.js';
import { maximumRateThreshold, spikePhaseOffsets } from '../lib/endurance.js';
import {
  abortingThreshold,
  executeLongRunIteration,
  setupLongRun,
  teardownLongRun,
} from '../lib/long-run.js';
import { createHandleSummary } from '../lib/summary.js';

const config = loadConfig(__ENV, { scenario: 'spike' });
const offsets = spikePhaseOffsets(config);
const abortDelay = `${Math.max(
  1,
  Math.ceil(
    (config.watchdogPollIntervalMs * config.watchdogConsecutiveViolations) /
      1000,
  ),
)}s`;

function arrivalScenario(rate, duration, startTime, phase) {
  return {
    executor: 'constant-arrival-rate',
    exec: phase,
    rate,
    timeUnit: config.loadTimeUnit,
    duration,
    startTime,
    preAllocatedVUs: config.loadPreAllocatedVus,
    maxVUs: config.loadMaxVus,
    gracefulStop: '30s',
    tags: { scenario: config.scenario, load_phase: phase },
  };
}

export const options = {
  scenarios: {
    spike_baseline: arrivalScenario(
      config.spikeBaselineRps,
      config.spikeBaselineDuration,
      '0s',
      'baseline',
    ),
    spike_peak: arrivalScenario(
      config.spikePeakRps,
      config.spikePeakDuration,
      `${config.spikeBaselineDurationMs}ms`,
      'peak',
    ),
    spike_recovery: arrivalScenario(
      config.spikeBaselineRps,
      config.spikeRecoveryDuration,
      `${config.spikeBaselineDurationMs + config.spikePeakDurationMs}ms`,
      'recovery',
    ),
  },
  thresholds: {
    unexpected_error_rate: abortingThreshold(
      maximumRateThreshold(config.watchdogMaxUnexpectedErrorRate),
      abortDelay,
    ),
    dropped_iterations: abortingThreshold('count==0', abortDelay),
    spike_peak_accepted_duration_ms: ['p(95)<200', 'p(99)<500'],
    spike_recovery_accepted_duration_ms: ['p(95)<200', 'p(99)<500'],
  },
  setupTimeout: config.loadSetupAllowance,
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
  discardResponseBodies: false,
};

export function setup() {
  return setupLongRun(
    loadConfig(__ENV, { requireExecution: true, scenario: 'spike' }),
    __ENV,
  );
}

function runPhase(data, phase) {
  const iteration = offsets[phase] + exec.scenario.iterationInTest;
  const elapsedMs = Math.max(0, Date.now() - Number(exec.scenario.startTime));
  executeLongRunIteration(config, data, iteration, phase, elapsedMs);
}

export function baseline(data) {
  runPhase(data, 'baseline');
}

export function peak(data) {
  runPhase(data, 'peak');
}

export function recovery(data) {
  runPhase(data, 'recovery');
}

export function teardown(data) {
  teardownLongRun(config, __ENV, data);
}

export const handleSummary = createHandleSummary(config);
