import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRunEnvironment } from '../tools/remote-agent.mjs';

test('post-recovery preflight receives the resumed run identity', () => {
  const environment = buildRunEnvironment(
    { BASE_URL: 'http://internal.example', RUN_ID: 'stale-run' },
    {
      runId: 'phase12-candidate-soak',
      scenario: 'soak',
      env: { SOAK_DURATION: '60m' },
    },
  );

  assert.equal(environment.RUN_ID, 'phase12-candidate-soak');
  assert.equal(environment.SCENARIO, 'soak');
  assert.equal(environment.SOAK_DURATION, '60m');
  assert.equal(environment.BASE_URL, 'http://internal.example');
});
