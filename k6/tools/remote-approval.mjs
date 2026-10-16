#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(
  toolDirectory,
  '..',
  'remote',
  'remote-approval.schema.json',
);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function formatErrors(errors = []) {
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

export async function validateRemoteApproval(
  raw,
  {
    approvalId,
    versionId,
    checksum,
    now = new Date(),
    requireActiveWindow = true,
  } = {},
) {
  if (!approvalId || !versionId || !checksum) {
    throw new Error(
      'approval ID, immutable S3 version ID, and SHA-256 checksum are required',
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/.test(approvalId)) {
    throw new Error('approval ID is invalid');
  }
  if (versionId === 'null' || versionId.length > 1024) {
    throw new Error('an immutable, non-null S3 version ID is required');
  }
  if (!/^[0-9a-f]{64}$/.test(checksum) || sha256(raw) !== checksum) {
    throw new Error('approval checksum does not match the versioned object');
  }

  let approval;
  try {
    approval = JSON.parse(raw);
  } catch {
    throw new Error('approval object is not valid JSON');
  }

  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addFormat('date-time', {
    type: 'string',
    validate: (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) &&
      Number.isFinite(Date.parse(value)),
  });
  const validate = ajv.compile(schema);
  if (!validate(approval)) {
    throw new Error(
      `approval schema rejected: ${formatErrors(validate.errors)}`,
    );
  }
  if (approval.approvalId !== approvalId) {
    throw new Error('approval ID does not match the versioned object');
  }
  if (approval.environment.approvalKey !== `approvals/${approvalId}.json`) {
    throw new Error('approval S3 key does not match the approval ID');
  }
  if (
    approval.environment.approvalBucket !== approval.environment.artifactBucket
  ) {
    throw new Error(
      'approval and artifact objects must use the dedicated versioned bucket',
    );
  }
  const start = Date.parse(approval.window.startsAt);
  const end = Date.parse(approval.window.endsAt);
  if (end <= start || end - start > 24 * 60 * 60 * 1000) {
    throw new Error('approval window must be positive and at most 24 hours');
  }
  const instant = now.getTime();
  if (requireActiveWindow && (instant < start || instant > end)) {
    throw new Error('approval window is not active');
  }
  const baseUrl = new URL(approval.environment.baseUrl);
  if (
    baseUrl.protocol !== 'http:' ||
    !baseUrl.hostname.startsWith('internal-') ||
    !baseUrl.hostname.endsWith('.elb.amazonaws.com') ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.port ||
    baseUrl.pathname !== '/'
  ) {
    throw new Error('BASE_URL must identify the internal HTTP ALB exactly');
  }
  if (
    approval.mode.kind === 'candidate-only' &&
    Object.hasOwn(approval.images, 'baseline')
  ) {
    throw new Error('candidate-only approval must not imply a baseline');
  }
  if (approval.resume) {
    if (
      approval.resume.sourceApprovalId !== approval.approvalId ||
      approval.resume.sourceVersionId === versionId
    ) {
      throw new Error(
        'resume must reference a different immutable version of the same approval ID',
      );
    }
  }
  return Object.freeze({
    approval: Object.freeze(approval),
    checksum,
    versionId,
  });
}

export async function loadRemoteApprovalFile(filePath, options) {
  const raw = await readFile(filePath, 'utf8');
  return validateRemoteApproval(raw, options);
}
