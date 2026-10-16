import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { sha256, validateRemoteApproval } from '../tools/remote-approval.mjs';

const exampleUrl = new URL(
  '../remote/remote-approval.example.json',
  import.meta.url,
);

async function example() {
  const raw = await readFile(exampleUrl, 'utf8');
  return { raw, value: JSON.parse(raw) };
}

test('validates a checksum-bound candidate-only approval', async () => {
  const { raw } = await example();
  const result = await validateRemoteApproval(raw, {
    approvalId: 'replace-me',
    versionId: 'version-1',
    checksum: sha256(raw),
    now: new Date('2099-01-01T01:00:00Z'),
  });
  assert.equal(result.approval.infrastructure.appInstanceCount, 7);
});

test('rejects approval tampering and inactive windows', async () => {
  const { raw } = await example();
  await assert.rejects(
    validateRemoteApproval(`${raw} `, {
      approvalId: 'replace-me',
      versionId: 'version-1',
      checksum: sha256(raw),
      now: new Date('2099-01-01T01:00:00Z'),
    }),
    /checksum/,
  );
  await assert.rejects(
    validateRemoteApproval(raw, {
      approvalId: 'replace-me',
      versionId: 'version-1',
      checksum: sha256(raw),
      now: new Date('2098-01-01T01:00:00Z'),
    }),
    /window/,
  );
});

test('requires baseline image identity in comparison mode', async () => {
  const { value } = await example();
  value.mode = { kind: 'comparison' };
  const raw = `${JSON.stringify(value)}\n`;
  await assert.rejects(
    validateRemoteApproval(raw, {
      approvalId: value.approvalId,
      versionId: 'version-1',
      checksum: sha256(raw),
      now: new Date('2099-01-01T01:00:00Z'),
    }),
    /baseline/,
  );
});

test('accepts a checksum-bound resume lineage to an older immutable version', async () => {
  const { value } = await example();
  value.resume = {
    sourceApprovalId: value.approvalId,
    sourceVersionId: 'version-1',
    sourceChecksum: 'a'.repeat(64),
    executionTimestamp: '20990101000000000',
  };
  const raw = `${JSON.stringify(value)}\n`;
  const result = await validateRemoteApproval(raw, {
    approvalId: value.approvalId,
    versionId: 'version-2',
    checksum: sha256(raw),
    now: new Date('2099-01-01T01:00:00Z'),
  });
  assert.equal(result.approval.resume.sourceVersionId, 'version-1');
});

test('rejects resume lineage that changes the approval ID', async () => {
  const { value } = await example();
  value.resume = {
    sourceApprovalId: 'different-approval',
    sourceVersionId: 'version-1',
    sourceChecksum: 'a'.repeat(64),
    executionTimestamp: '20990101000000000',
  };
  const raw = `${JSON.stringify(value)}\n`;
  await assert.rejects(
    validateRemoteApproval(raw, {
      approvalId: value.approvalId,
      versionId: 'version-2',
      checksum: sha256(raw),
      now: new Date('2099-01-01T01:00:00Z'),
    }),
    /same approval ID/,
  );
});
