import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCleanupDrainProof,
  assertRecoveryProducerFence,
  buildRunEnvironment,
  hasExclusiveHostFence,
  isGeneratorRetired,
} from '../tools/remote-agent.mjs';

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

test('cleanup is rejected unless the finalized audit proves a full drain', () => {
  const audit = {
    runId: 'remote-run',
    drain: { timedOut: false },
    queues: { pending: 0, processing: 0 },
    counters: { worker_in_flight: 0 },
  };
  assert.doesNotThrow(() => assertCleanupDrainProof(audit, 'remote-run'));
  audit.queues.pending = 1;
  assert.throws(
    () => assertCleanupDrainProof(audit, 'remote-run'),
    /no verified producer and worker drain proof/,
  );
});

test('only an absent, stopped, or terminated source generator is fenced', () => {
  assert.equal(isGeneratorRetired({ Reservations: [] }, 'i-source'), true);
  assert.equal(
    isGeneratorRetired(
      {
        Reservations: [
          {
            Instances: [{ InstanceId: 'i-source', State: { Name: 'stopped' } }],
          },
        ],
      },
      'i-source',
    ),
    true,
  );
  assert.equal(
    isGeneratorRetired(
      {
        Reservations: [
          {
            Instances: [{ InstanceId: 'i-source', State: { Name: 'running' } }],
          },
        ],
      },
      'i-source',
    ),
    false,
  );
});

test('same-host recovery requires the exact host lock proof', () => {
  assert.equal(
    hasExclusiveHostFence({ RECOVERY_HOST_LOCK_PROOF: 'exclusive-v1' }),
    true,
  );
  assert.equal(
    hasExclusiveHostFence({ RECOVERY_HOST_LOCK_PROOF: 'true' }),
    false,
  );
  assert.equal(hasExclusiveHostFence({}), false);
});

test('resume fails closed unless the source producer is fenced', () => {
  assert.doesNotThrow(() =>
    assertRecoveryProducerFence({
      sameGenerator: true,
      hostFence: true,
      sourceRetired: false,
    }),
  );
  assert.doesNotThrow(() =>
    assertRecoveryProducerFence({
      sameGenerator: false,
      hostFence: false,
      sourceRetired: true,
    }),
  );
  assert.throws(
    () =>
      assertRecoveryProducerFence({
        sameGenerator: false,
        hostFence: false,
        sourceRetired: false,
      }),
    /producer is not fenced/,
  );
  assert.throws(
    () =>
      assertRecoveryProducerFence({
        sameGenerator: true,
        hostFence: false,
        sourceRetired: true,
      }),
    /producer is not fenced/,
  );
});
