import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  assertResumeScope,
  validateSealedRunArtifacts,
} from '../tools/remote-resume.mjs';

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
