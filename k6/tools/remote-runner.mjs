#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { fetchVersionedRemoteApproval } from './remote-approval-s3.mjs';
import { verifyLocalGates } from './remote-gates.mjs';
import { inspectRemoteInfrastructure, awsJson } from './remote-inventory.mjs';
import { buildRemoteExecutionMatrix } from './remote-plan.mjs';
import { verifyRemoteStorage } from './remote-storage.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (!['validate', 'execute'].includes(command)) {
    throw new Error(
      'usage: run-remote validate|execute --approval-id ID --version-id ID --checksum SHA256 [--execute]',
    );
  }
  const values = {};
  let executeFlag = false;
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === '--execute') {
      executeFlag = true;
      continue;
    }
    if (
      !['--approval-id', '--version-id', '--checksum'].includes(item) ||
      !rest[index + 1]
    ) {
      throw new Error(`unknown or incomplete argument: ${item}`);
    }
    values[item.slice(2).replaceAll('-', '')] = rest[++index];
  }
  if (!values.approvalid || !values.versionid || !values.checksum) {
    throw new Error('approval ID, version ID, and checksum are required');
  }
  if ((command === 'execute') !== executeFlag) {
    throw new Error(
      'execute requires the literal --execute flag; validate forbids it',
    );
  }
  return {
    command,
    approvalId: values.approvalid,
    versionId: values.versionid,
    checksum: values.checksum,
  };
}

export function documentPrefix(approval) {
  const parts = approval.environment.applicationParameterName
    .split('/')
    .filter(Boolean);
  if (parts.length !== 3 || parts[2] !== 'app') {
    throw new Error(
      'application parameter name cannot identify the Terraform environment',
    );
  }
  return parts[0];
}

async function sendCommand(
  region,
  documentName,
  instanceIds,
  parameters,
  timeoutSeconds,
  output = null,
) {
  const args = [
    'ssm',
    'send-command',
    '--document-name',
    documentName,
    '--instance-ids',
    ...instanceIds,
    '--parameters',
    JSON.stringify(parameters),
    '--timeout-seconds',
    String(timeoutSeconds),
  ];
  if (output) {
    args.push(
      '--output-s3-bucket-name',
      output.bucket,
      '--output-s3-key-prefix',
      output.keyPrefix,
    );
  }
  const response = await awsJson(region, args);
  const commandId = response.Command?.CommandId;
  if (!commandId) throw new Error('SSM did not return a command ID');
  return commandId;
}

async function waitForCommand(region, commandId, instanceId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await awsJson(region, [
      'ssm',
      'get-command-invocation',
      '--command-id',
      commandId,
      '--instance-id',
      instanceId,
    ]).catch((error) => {
      if (/InvocationDoesNotExist/.test(error.message)) return null;
      throw error;
    });
    if (
      result &&
      ['Success', 'Cancelled', 'TimedOut', 'Failed', 'Cancelling'].includes(
        result.Status,
      )
    ) {
      if (result.Status !== 'Success') {
        throw new Error(
          `SSM command ${commandId} failed on ${instanceId}: ${result.StatusDetails || result.Status}`,
        );
      }
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`SSM command ${commandId} timed out on ${instanceId}`);
}

async function deployImage(approval, image, documentName) {
  const { region, appInstanceIds } = approval.environment;
  try {
    return await inspectRemoteInfrastructure(approval, image);
  } catch (error) {
    if (
      !/deployed application identity does not match approval/.test(
        error.message,
      )
    ) {
      throw error;
    }
  }
  for (let index = 0; index < appInstanceIds.length; index += 1) {
    const instanceId = appInstanceIds[index];
    const commandId = await sendCommand(
      region,
      documentName,
      [instanceId],
      {
        ImageDigest: [image.digest],
        BuildSha: [image.gitSha],
        RunMigration: [index === 0 ? 'true' : 'false'],
      },
      1200,
    );
    const result = await waitForCommand(
      region,
      commandId,
      instanceId,
      20 * 60_000,
    );
    if (!result.StandardOutputContent?.includes(image.digest)) {
      throw new Error(`deployed digest could not be verified on ${instanceId}`);
    }
  }
  await awsJson(
    region,
    [
      'ec2',
      'create-tags',
      '--resources',
      ...appInstanceIds,
      '--tags',
      `Key=FastPassImageDigest,Value=${image.digest}`,
      `Key=FastPassBuildSha,Value=${image.gitSha}`,
    ],
    { allowEmpty: true },
  );
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    try {
      return await inspectRemoteInfrastructure(approval, image);
    } catch (error) {
      if (!/target health/.test(error.message)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error('ALB targets did not all become healthy after deployment');
}

async function executeRole(approval, identity, imageRole, documentName) {
  const image = approval.images[imageRole];
  await deployImage(
    approval,
    image,
    `${documentPrefix(approval)}-deploy-app-digest`,
  );
  const commandId = await sendCommand(
    approval.environment.region,
    documentName,
    [approval.environment.loadGeneratorInstanceId],
    {
      ApprovalBucket: [approval.environment.approvalBucket],
      ApprovalId: [identity.approvalId],
      ApprovalVersionId: [identity.versionId],
      ApprovalChecksum: [identity.checksum],
      ExecutionTimestamp: [identity.executionTimestamp],
      ImageRole: [imageRole],
      Execute: ['true'],
    },
    86_400,
    {
      bucket: approval.environment.artifactBucket,
      keyPrefix: `runs/commands/${identity.approvalId}/${identity.executionTimestamp}/${imageRole}`,
    },
  );
  await waitForCommand(
    approval.environment.region,
    commandId,
    approval.environment.loadGeneratorInstanceId,
    24 * 60 * 60_000,
  );
}

async function recordRemoteVerification(approval, identity, matrix) {
  const bucket = approval.environment.artifactBucket;
  const region = approval.environment.region;
  for (const run of matrix) {
    for (const name of ['metadata.json', 'cleanup.json', 'checksums.sha256']) {
      const object = await awsJson(region, [
        's3api',
        'head-object',
        '--bucket',
        bucket,
        '--key',
        `runs/summary/${run.runId}/${name}`,
      ]);
      if (!/^[0-9a-f]{64}$/.test(object.Metadata?.sha256 || '')) {
        throw new Error(
          `${run.runId}/${name} is missing its checksum metadata`,
        );
      }
    }
  }
  const record = {
    schemaVersion: 1,
    status: 'REMOTE_VERIFIED',
    approval: {
      id: identity.approvalId,
      versionId: identity.versionId,
      checksum: identity.checksum,
    },
    executionTimestamp: identity.executionTimestamp,
    finalizedAt: new Date().toISOString(),
    mode: approval.mode.kind,
    runs: matrix.map((run) => ({
      runId: run.runId,
      imageRole: run.imageRole,
      scenario: run.scenario,
      purpose: run.purpose,
    })),
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const checksum = createHash('sha256').update(body).digest('hex');
  const directory = await mkdtemp(
    path.join(tmpdir(), 'fast-pass-verification-'),
  );
  const filePath = path.join(directory, 'remote-verification.json');
  try {
    await writeFile(filePath, body, { mode: 0o600, flag: 'wx' });
    await execFileAsync(
      'aws',
      [
        '--region',
        region,
        's3api',
        'put-object',
        '--bucket',
        bucket,
        '--key',
        `runs/qualification/${identity.approvalId}/${identity.executionTimestamp}.json`,
        '--body',
        filePath,
        '--server-side-encryption',
        'AES256',
        '--content-type',
        'application/json',
        '--metadata',
        `sha256=${checksum},retention=permanent`,
        '--no-cli-pager',
      ],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return record;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const bucket = process.env.REMOTE_APPROVAL_BUCKET || '';
  const verified = await fetchVersionedRemoteApproval({
    bucket,
    approvalId: args.approvalId,
    versionId: args.versionId,
    checksum: args.checksum,
  });
  const { approval } = verified;
  await Promise.all([
    verifyLocalGates(repositoryRoot, approval),
    inspectRemoteInfrastructure(approval),
    verifyRemoteStorage(approval),
  ]);
  const matrixStartedAt = new Date();
  const executionTimestamp =
    approval.resume?.executionTimestamp ||
    matrixStartedAt.toISOString().replace(/\D/g, '').slice(0, 17);
  const matrix = buildRemoteExecutionMatrix(
    approval,
    matrixStartedAt,
    executionTimestamp,
  );
  if (args.command === 'validate') {
    process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
    return;
  }

  const identity = {
    approvalId: args.approvalId,
    versionId: args.versionId,
    checksum: args.checksum,
    executionTimestamp,
  };
  const runnerDocument = `${documentPrefix(approval)}-run-approved-load-test`;
  const roles =
    approval.mode.kind === 'comparison'
      ? ['baseline', 'candidate']
      : ['candidate'];
  for (const role of roles) {
    await executeRole(approval, identity, role, runnerDocument);
  }
  const verification = await recordRemoteVerification(
    approval,
    identity,
    matrix,
  );
  process.stdout.write(
    `${JSON.stringify({ status: verification.status, approvalId: args.approvalId, roles, runCount: matrix.length })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`remote runner rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
