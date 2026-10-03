import { loadConfig } from '../lib/config.js';
import {
  executeConsistency,
  setupConsistency,
  teardownConsistency,
} from '../lib/consistency-scenario.js';
import { createHandleSummary } from '../lib/summary.js';

const config = loadConfig(__ENV, { scenario: 'consistency-one-seat' });

export const options = {
  scenarios: {
    consistency_one_seat: {
      executor: 'per-vu-iterations',
      vus: config.vus,
      iterations: 1,
      maxDuration: config.duration,
      gracefulStop: '1s',
      tags: { scenario: config.scenario, cache_profile: config.cacheProfile },
    },
  },
  thresholds: {
    checks: ['rate==1'],
    accepted: [`count==${config.expectedAccepted}`],
    expected_conflict: [`count==${config.expectedConflicts}`],
    unexpected_error: ['count==0'],
    timeout: ['count==0'],
    iterations: [`count==${config.totalIterations}`],
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

export default function (data) {
  executeConsistency(config, data);
}

export function teardown(data) {
  teardownConsistency(config, __ENV.TEST_PREFLIGHT_TOKEN, data);
}

export const handleSummary = createHandleSummary(config);
