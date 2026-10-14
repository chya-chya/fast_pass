import { awsJson } from './remote-inventory.mjs';

export async function verifyRemoteStorage(approval) {
  const region = approval.environment.region;
  const bucket = approval.environment.artifactBucket;
  const [versioning, publicAccess, encryption, lifecycle] = await Promise.all([
    awsJson(region, ['s3api', 'get-bucket-versioning', '--bucket', bucket]),
    awsJson(region, ['s3api', 'get-public-access-block', '--bucket', bucket]),
    awsJson(region, ['s3api', 'get-bucket-encryption', '--bucket', bucket]),
    awsJson(region, [
      's3api',
      'get-bucket-lifecycle-configuration',
      '--bucket',
      bucket,
    ]),
  ]);
  const block = publicAccess.PublicAccessBlockConfiguration || {};
  const encryptionRules =
    encryption.ServerSideEncryptionConfiguration?.Rules || [];
  const rawRule = (lifecycle.Rules || []).find(
    (rule) =>
      rule.Status === 'Enabled' &&
      rule.Filter?.Prefix === 'runs/raw/' &&
      rule.Expiration?.Days === approval.retention.rawTimeseriesDays,
  );
  if (
    versioning.Status !== 'Enabled' ||
    !block.BlockPublicAcls ||
    !block.BlockPublicPolicy ||
    !block.IgnorePublicAcls ||
    !block.RestrictPublicBuckets ||
    !encryptionRules.some((rule) =>
      ['AES256', 'aws:kms'].includes(
        rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
      ),
    ) ||
    !rawRule
  ) {
    throw new Error(
      'artifact bucket retention or security controls do not match approval',
    );
  }
  return {
    bucket,
    versioning: versioning.Status,
    encryption: 'enabled',
    publicAccessBlocked: true,
    rawTimeseriesDays: rawRule.Expiration.Days,
  };
}
