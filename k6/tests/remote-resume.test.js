import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertNoLegacyRecoveryEvidence,
  assertResumeScope,
  validateRecoveryIntent,
  validateRemoteChecksumSet,
  validateSealedRunArtifacts,
} from '../tools/remote-resume.mjs';
import { createHash } from 'node:crypto';

const exampleUrl = new URL(
  '../remote/remote-approval.example.json',
  import.meta.url,
);

async function approvals() {
  const source = JSON.parse(await readFile(exampleUrl, 'utf8'));
  source.approvalId = 'resume-approval';
  const current = structuredClone(source);
  current.window = {
    startsAt: '2099-01-02T00:00:00Z',
    endsAt: '2099-01-02T04:00:00Z',
  };
  current.environment.loadGeneratorInstanceId = 'i-fedcba9876543210';
  current.images.runner = {
    gitSha: 'b'.repeat(40),
    digest: `sha256:${'c'.repeat(64)}`,
  };
  current.resume = {
    sourceApprovalId: source.approvalId,
    sourceVersionId: 'source-version',
    sourceChecksum: 'd'.repeat(64),
    executionTimestamp: '20990101000000000',
  };
  return { source, current };
}

test('resume scope permits only runner, generator, and window changes', async () => {
  const { source, current } = await approvals();
  assert.doesNotThrow(() =>
    assertResumeScope(current, source, {
      approvalId: source.approvalId,
      versionId: 'source-version',
      checksum: 'd'.repeat(64),
    }),
  );
  const expanded = structuredClone(current);
  expanded.abort.queueDepth += 1;
  assert.throws(
    () =>
      assertResumeScope(expanded, source, {
        approvalId: source.approvalId,
        versionId: 'source-version',
        checksum: 'd'.repeat(64),
      }),
    /expands or changes/,
  );
});

test('sealed source run is reusable only with verified exact cleanup', async () => {
  const { source, current } = await approvals();
  const run = {
    runId: 'resume-run',
    scenario: 'spike',
    imageRole: 'candidate',
  };
  const metadata = {
    runId: run.runId,
    scenario: run.scenario,
    execution: 'COMPLETED',
    artifactSet: 'FINALIZED',
    preflight: 'VERIFIED',
    audit: { pass: true },
    cleanup: { status: 'VERIFIED' },
    remoteApproval: {
      approvalId: source.approvalId,
      versionId: 'source-version',
      checksum: 'd'.repeat(64),
      executionTimestamp: current.resume.executionTimestamp,
    },
    immutableImages: {
      role: 'candidate',
      applicationGitSha: source.images.candidate.gitSha,
      applicationDigest: source.images.candidate.digest,
      runnerDigest: source.images.runner.digest,
    },
  };
  const cleanup = {
    runId: run.runId,
    mode: 'executed',
    verification: {
      runOwnedRowsRemaining: 0,
      foreignRunDataPreserved: true,
    },
  };
  assert.equal(
    validateSealedRunArtifacts({
      metadata,
      cleanup,
      run,
      approval: current,
      currentIdentity: {
        approvalId: current.approvalId,
        versionId: 'current-version',
        checksum: 'e'.repeat(64),
      },
      sourceApproval: source,
    }),
    true,
  );
  cleanup.verification.runOwnedRowsRemaining = 1;
  assert.throws(
    () =>
      validateSealedRunArtifacts({
        metadata,
        cleanup,
        run,
        approval: current,
        currentIdentity: {
          approvalId: current.approvalId,
          versionId: 'current-version',
          checksum: 'e'.repeat(64),
        },
        sourceApproval: source,
      }),
    /cleanup proof/,
  );
});

test('rejects a finalized artifact set assembled from different upload generations', () => {
  const names = [
    'metadata.json',
    'fixture-manifest.json',
    'summary.json',
    'consistency-audit.json',
    'server-metrics.json',
    'report.md',
    'cleanup.json',
  ];
  const objects = Object.fromEntries(names.map((name) => [name, `${name}\n`]));
  const checksum = (value) => createHash('sha256').update(value).digest('hex');
  objects['checksums.sha256'] = `${names
    .map((name) => `${checksum(objects[name])}  ${name}`)
    .join('\n')}\n`;
  assert.doesNotThrow(() => validateRemoteChecksumSet(objects));
  objects['summary.json'] = 'new generation\n';
  assert.throws(
    () => validateRemoteChecksumSet(objects),
    /generation mismatch/,
  );
});

test('recovery intent is bound to approval identity and immutable application image', async () => {
  const { current } = await approvals();
  const run = {
    runId: 'resume-run',
    scenario: 'smoke',
    imageRole: 'candidate',
  };
  const identity = {
    approvalId: current.approvalId,
    versionId: 'current-version',
    checksum: 'e'.repeat(64),
    executionTimestamp: current.resume.executionTimestamp,
  };
  const intent = {
    runId: run.runId,
    testEnvId: current.environment.id,
    scenario: run.scenario,
    fixture: { kind: 'deterministic-v1' },
    remoteApproval: { ...identity },
    immutableImages: {
      role: run.imageRole,
      applicationDigest: current.images.candidate.digest,
    },
  };
  assert.equal(validateRecoveryIntent(intent, run, current, identity), true);
  intent.remoteApproval.checksum = 'f'.repeat(64);
  assert.throws(
    () => validateRecoveryIntent(intent, run, current, identity),
    /not reusable/,
  );
});

test('legacy metadata or raw evidence cannot authorize deterministic cleanup', () => {
  assert.doesNotThrow(() =>
    assertNoLegacyRecoveryEvidence(false, 'resume-run'),
  );
  assert.throws(
    () => assertNoLegacyRecoveryEvidence(true, 'resume-run'),
    /legacy evidence.*manual intervention/,
  );
});
