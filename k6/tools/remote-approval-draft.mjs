#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sha256, validateRemoteApproval } from './remote-approval.mjs';

const execFileAsync = promisify(execFile);
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, '..', '..');
const terraformDirectory = path.join(repositoryRoot, 'infra', 'load-test');
const examplePath = path.join(
  repositoryRoot,
  'k6',
  'remote',
  'remote-approval.example.json',
);

const VALUE_FLAGS = new Set([
  '--approval-id',
  '--approved-by',
  '--cost-owner',
  '--incident-owner',
  '--starts-at',
  '--ends-at',
  '--baseline-absence-reason',
  '--baseline-absence-evidence',
  '--output',
]);

export function parseDraftArguments(argv) {
  const values = {};
  let acknowledged = false;
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--acknowledge-candidate-only') {
      acknowledged = true;
      continue;
    }
    if (!VALUE_FLAGS.has(item) || !argv[index + 1]) {
      throw new Error(`unknown or incomplete argument: ${item}`);
    }
    if (Object.hasOwn(values, item)) {
      throw new Error(`duplicate argument: ${item}`);
    }
    values[item] = argv[++index];
  }
  for (const flag of VALUE_FLAGS) {
    if (!values[flag]) throw new Error(`${flag} is required`);
  }
  if (!acknowledged) {
    throw new Error(
      '--acknowledge-candidate-only is required because no baseline comparison will be reported',
    );
  }
  return Object.freeze({ ...values, acknowledged });
}

function outputValue(outputs, name) {
  const entry = outputs[name];
  if (!entry || entry.value === undefined || entry.value === null) {
    throw new Error(`Terraform output ${name} is unavailable`);
  }
  return entry.value;
}

export async function buildCandidateApprovalDraft(args, outputs) {
  const example = JSON.parse(await readFile(examplePath, 'utf8'));
  const descriptor = outputValue(outputs, 'environment_descriptor');
  const images = outputValue(outputs, 'image_descriptor');
  const generatorId = outputValue(outputs, 'load_generator_instance_id');
  const approvalId = args['--approval-id'];

  const draft = {
    ...example,
    approvalId,
    approvedBy: args['--approved-by'],
    responsibility: {
      costOwner: args['--cost-owner'],
      incidentOwner: args['--incident-owner'],
    },
    environment: {
      ...example.environment,
      id: descriptor.environment_id,
      baseUrl: outputValue(outputs, 'internal_base_url'),
      awsAccountId: outputValue(outputs, 'aws_account_id'),
      region: outputValue(outputs, 'region'),
      artifactBucket: outputValue(outputs, 'artifact_bucket_name'),
      approvalBucket: outputValue(outputs, 'artifact_bucket_name'),
      approvalKey: `approvals/${approvalId}.json`,
      targetGroupArn: outputValue(outputs, 'target_group_arn'),
      appInstanceIds: outputValue(outputs, 'app_instance_ids'),
      loadGeneratorInstanceId: generatorId,
      databaseIdentifier: outputValue(outputs, 'database_identifier'),
      databaseName: outputValue(outputs, 'database_name'),
      redisReplicationGroupId: outputValue(
        outputs,
        'redis_replication_group_id',
      ),
      applicationParameterName: outputValue(
        outputs,
        'application_parameter_name',
      ),
    },
    window: {
      startsAt: args['--starts-at'],
      endsAt: args['--ends-at'],
    },
    mode: {
      kind: 'candidate-only',
      baselineAbsenceReason: args['--baseline-absence-reason'],
      baselineAbsenceEvidence: args['--baseline-absence-evidence'],
    },
    images: {
      candidate: {
        gitSha: images.candidate.git_sha,
        digest: images.candidate.digest,
      },
      runner: {
        gitSha: images.runner.git_sha,
        digest: images.runner.digest,
      },
    },
  };
  const raw = `${JSON.stringify(draft, null, 2)}\n`;
  await validateRemoteApproval(raw, {
    approvalId,
    versionId: 'draft-version',
    checksum: sha256(raw),
    requireActiveWindow: false,
  });
  if (Date.parse(draft.window.endsAt) <= Date.now()) {
    throw new Error('approval window must not already be expired');
  }
  return Object.freeze({ draft, raw, checksum: sha256(raw) });
}

async function terraformOutputs() {
  const { stdout } = await execFileAsync(
    'terraform',
    [`-chdir=${terraformDirectory}`, 'output', '-json'],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

async function main() {
  const args = parseDraftArguments(process.argv.slice(2));
  const prepared = await buildCandidateApprovalDraft(
    args,
    await terraformOutputs(),
  );
  const outputPath = path.resolve(args['--output']);
  if (path.extname(outputPath) !== '.json') {
    throw new Error('approval draft output must use a .json extension');
  }
  await writeFile(outputPath, prepared.raw, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ status: 'DRAFT_CREATED_NOT_PUBLISHED', outputPath, checksum: prepared.checksum })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`approval draft rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
