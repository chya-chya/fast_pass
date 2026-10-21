import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCandidateApprovalDraft,
  parseDraftArguments,
} from '../tools/remote-approval-draft.mjs';

const argumentsList = [
  '--approval-id',
  'phase12-candidate-01',
  '--approved-by',
  'load-test-approver',
  '--cost-owner',
  'cost-owner',
  '--incident-owner',
  'incident-owner',
  '--starts-at',
  '2099-01-01T00:00:00Z',
  '--ends-at',
  '2099-01-01T04:00:00Z',
  '--baseline-absence-reason',
  'No immutable baseline image has been approved for this environment.',
  '--baseline-absence-evidence',
  'Release records contain no prior approved baseline digest.',
  '--output',
  'k6/remote/remote-approval.local.json',
  '--acknowledge-candidate-only',
];

function outputs(generatorId = 'i-00000000000000008') {
  const value = (entry) => ({ value: entry });
  return {
    environment_descriptor: value({
      environment_id: 'aws-free-01',
      load_generator_max_lifetime_hours: 26,
    }),
    image_descriptor: value({
      candidate: {
        git_sha: '1'.repeat(40),
        digest: `sha256:${'1'.repeat(64)}`,
      },
      runner: {
        git_sha: '2'.repeat(40),
        digest: `sha256:${'2'.repeat(64)}`,
      },
    }),
    load_generator_instance_id: value(generatorId),
    internal_base_url: value(
      'http://internal-fast-pass-free-app-1.ap-northeast-2.elb.amazonaws.com',
    ),
    aws_account_id: value('000000000000'),
    region: value('ap-northeast-2'),
    artifact_bucket_name: value('fast-pass-artifacts-example'),
    target_group_arn: value(
      'arn:aws:elasticloadbalancing:ap-northeast-2:000000000000:targetgroup/example/0000000000000000',
    ),
    app_instance_ids: value(
      Array.from(
        { length: 7 },
        (_, index) => `i-${String(index + 1).padStart(17, '0')}`,
      ),
    ),
    database_identifier: value('fast-pass-free'),
    database_name: value('fast_pass_k6_aws_free_01'),
    redis_replication_group_id: value('fast-pass-free'),
    application_parameter_name: value('/fast-pass-free/aws-free-01/app'),
  };
}

test('draft creation requires an explicit candidate-only acknowledgement', () => {
  assert.throws(
    () => parseDraftArguments(argumentsList.slice(0, -1)),
    /acknowledge-candidate-only/,
  );
});

test('builds a schema-valid draft from live Terraform outputs', async () => {
  const draft = await buildCandidateApprovalDraft(
    parseDraftArguments(argumentsList),
    outputs(),
  );
  assert.equal(
    draft.draft.environment.loadGeneratorInstanceId,
    'i-00000000000000008',
  );
  assert.equal(draft.draft.mode.kind, 'candidate-only');
  assert.match(draft.checksum, /^[0-9a-f]{64}$/);
});

test('refuses to draft approval before the temporary generator exists', async () => {
  await assert.rejects(
    buildCandidateApprovalDraft(
      parseDraftArguments(argumentsList),
      outputs(null),
    ),
    /load_generator_instance_id/,
  );
});

test('binds all resume lineage fields into the draft', async () => {
  const resumeArguments = [
    ...argumentsList,
    '--resume-source-file',
    '/tmp/source-approval.json',
    '--resume-source-approval-id',
    'phase12-candidate-01',
    '--resume-source-version-id',
    'source-version',
    '--resume-source-checksum',
    'a'.repeat(64),
    '--resume-execution-timestamp',
    '20990101000000000',
  ];
  const source = (
    await buildCandidateApprovalDraft(
      parseDraftArguments(argumentsList),
      outputs('i-00000000000000007'),
    )
  ).draft;
  const resumeOutputs = outputs();
  resumeOutputs.image_descriptor.value.runner = {
    git_sha: '9'.repeat(40),
    digest: `sha256:${'9'.repeat(64)}`,
  };
  const draft = await buildCandidateApprovalDraft(
    parseDraftArguments(resumeArguments),
    resumeOutputs,
    source,
  );
  assert.equal(draft.draft.resume.sourceVersionId, 'source-version');
  assert.deepEqual(draft.draft.images.runner, source.images.runner);
});
