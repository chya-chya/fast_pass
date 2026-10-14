#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { fetchVersionedRemoteApproval } from './remote-approval-s3.mjs';
import { sha256, validateRemoteApproval } from './remote-approval.mjs';

const execFileAsync = promisify(execFile);

export function parsePublishArguments(argv) {
  if (
    argv.length !== 3 ||
    argv[0] !== '--file' ||
    !argv[1] ||
    argv[2] !== '--publish'
  ) {
    throw new Error(
      'usage: publish-remote-approval --file <approved.json> --publish',
    );
  }
  return Object.freeze({ filePath: path.resolve(argv[1]) });
}

export async function validateApprovalForPublish(raw, now = new Date()) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('approval object is not valid JSON');
  }
  const checksum = sha256(raw);
  const verified = await validateRemoteApproval(raw, {
    approvalId: parsed.approvalId,
    versionId: 'prepublish-version',
    checksum,
    now,
    requireActiveWindow: false,
  });
  if (Date.parse(verified.approval.window.endsAt) <= now.getTime()) {
    throw new Error('approval window is already expired');
  }
  return Object.freeze({ approval: verified.approval, checksum });
}

async function main() {
  const args = parsePublishArguments(process.argv.slice(2));
  const raw = await readFile(args.filePath, 'utf8');
  const local = await validateApprovalForPublish(raw);
  const { approval } = local;
  const region = approval.environment.region;
  const bucket = approval.environment.approvalBucket;
  const key = approval.environment.approvalKey;
  const directory = await mkdtemp(
    path.join(tmpdir(), 'fast-pass-approved-upload-'),
  );
  const immutableCopy = path.join(directory, 'approval.json');
  try {
    // Upload exactly the bytes that were validated, even if the operator's
    // source file is edited concurrently after validation.
    await writeFile(immutableCopy, raw, { mode: 0o600, flag: 'wx' });
    const { stdout } = await execFileAsync(
      'aws',
      [
        '--region',
        region,
        's3api',
        'put-object',
        '--bucket',
        bucket,
        '--key',
        key,
        '--body',
        immutableCopy,
        '--server-side-encryption',
        'AES256',
        '--content-type',
        'application/json',
        '--metadata',
        `sha256=${local.checksum},approval-id=${approval.approvalId}`,
        '--output',
        'json',
        '--no-cli-pager',
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const response = JSON.parse(stdout || '{}');
    const versionId = response.VersionId;
    if (!versionId || versionId === 'null') {
      throw new Error('S3 did not return an immutable approval version ID');
    }
    await fetchVersionedRemoteApproval({
      bucket,
      approvalId: approval.approvalId,
      versionId,
      checksum: local.checksum,
      region,
      requireActiveWindow: false,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          status: 'PUBLISHED_AND_VERIFIED',
          approvalId: approval.approvalId,
          bucket,
          key,
          versionId,
          checksum: local.checksum,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`approval publication rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
