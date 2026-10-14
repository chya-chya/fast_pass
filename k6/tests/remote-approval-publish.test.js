import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  parsePublishArguments,
  validateApprovalForPublish,
} from '../tools/remote-approval-publish.mjs';

const exampleUrl = new URL(
  '../remote/remote-approval.example.json',
  import.meta.url,
);

test('publishing requires both an explicit file and literal publish flag', () => {
  assert.throws(
    () => parsePublishArguments(['--file', 'approval.json']),
    /--publish/,
  );
  assert.equal(
    parsePublishArguments([
      '--file',
      'approval.json',
      '--publish',
    ]).filePath.endsWith('approval.json'),
    true,
  );
});

test('pre-publish validation accepts a future immutable approval candidate', async () => {
  const raw = await readFile(exampleUrl, 'utf8');
  const verified = await validateApprovalForPublish(
    raw,
    new Date('2098-12-31T00:00:00Z'),
  );
  assert.equal(verified.approval.approvalId, 'replace-me');
  assert.match(verified.checksum, /^[0-9a-f]{64}$/);
});
