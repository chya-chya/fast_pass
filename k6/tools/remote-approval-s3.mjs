import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { validateRemoteApproval } from './remote-approval.mjs';

const execFileAsync = promisify(execFile);
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export async function fetchVersionedRemoteApproval({
  bucket,
  approvalId,
  versionId,
  checksum,
  region = 'ap-northeast-2',
  now = new Date(),
  requireActiveWindow = true,
}) {
  if (!BUCKET_PATTERN.test(bucket || '')) {
    throw new Error('REMOTE_APPROVAL_BUCKET is invalid');
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'fast-pass-approval-'));
  const destination = path.join(directory, 'approval.json');
  try {
    const key = `approvals/${approvalId}.json`;
    const { stdout } = await execFileAsync(
      'aws',
      [
        '--region',
        region,
        's3api',
        'get-object',
        '--bucket',
        bucket,
        '--key',
        key,
        '--version-id',
        versionId,
        '--checksum-mode',
        'ENABLED',
        destination,
        '--output',
        'json',
        '--no-cli-pager',
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const response = JSON.parse(stdout || '{}');
    if (response.VersionId !== versionId) {
      throw new Error('S3 returned a different approval version');
    }
    const raw = await readFile(destination, 'utf8');
    const verified = await validateRemoteApproval(raw, {
      approvalId,
      versionId,
      checksum,
      now,
      requireActiveWindow,
    });
    if (
      verified.approval.environment.approvalBucket !== bucket ||
      verified.approval.environment.approvalKey !== key ||
      verified.approval.environment.region !== region
    ) {
      throw new Error(
        'approval object location does not match its environment',
      );
    }
    return {
      ...verified,
      manifestUri: `s3://${bucket}/${key}?versionId=${versionId}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
