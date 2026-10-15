#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseAwsJson(stdout, options = {}) {
  const body = stdout.trim();
  if (!body) {
    if (options.allowEmpty) return {};
    throw new Error('AWS CLI returned an empty JSON response');
  }
  return JSON.parse(body);
}

export async function awsJson(region, args, options = {}) {
  const { stdout } = await execFileAsync(
    'aws',
    ['--region', region, ...args, '--output', 'json', '--no-cli-pager'],
    { timeout: options.timeout || 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return parseAwsJson(stdout, options);
}

function sameSet(left, right) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function tagValue(instance, key) {
  return (instance.Tags || []).find((tag) => tag.Key === key)?.Value;
}

export async function inspectRemoteInfrastructure(
  approval,
  expectedImage = null,
) {
  const { environment, infrastructure } = approval;
  const region = environment.region;
  const [identity, ec2, targetHealth, database, redis] = await Promise.all([
    awsJson(region, ['sts', 'get-caller-identity']),
    awsJson(region, [
      'ec2',
      'describe-instances',
      '--instance-ids',
      ...environment.appInstanceIds,
      environment.loadGeneratorInstanceId,
    ]),
    awsJson(region, [
      'elbv2',
      'describe-target-health',
      '--target-group-arn',
      environment.targetGroupArn,
    ]),
    awsJson(region, [
      'rds',
      'describe-db-instances',
      '--db-instance-identifier',
      environment.databaseIdentifier,
    ]),
    awsJson(region, [
      'elasticache',
      'describe-replication-groups',
      '--replication-group-id',
      environment.redisReplicationGroupId,
    ]),
  ]);
  if (identity.Account !== environment.awsAccountId) {
    throw new Error('AWS account does not match approval');
  }
  const instances = ec2.Reservations.flatMap((item) => item.Instances || []);
  const apps = instances.filter((instance) =>
    environment.appInstanceIds.includes(instance.InstanceId),
  );
  const generator = instances.find(
    (instance) => instance.InstanceId === environment.loadGeneratorInstanceId,
  );
  if (
    apps.length !== infrastructure.appInstanceCount ||
    apps.some(
      (instance) =>
        instance.InstanceType !== infrastructure.appInstanceType ||
        instance.State?.Name !== 'running' ||
        !instance.PrivateIpAddress ||
        tagValue(instance, 'FastPassPm2Workers') !==
          String(infrastructure.pm2WorkersPerInstance) ||
        tagValue(instance, 'FastPassDbPoolPerWorker') !==
          String(infrastructure.databasePoolPerWorker),
    )
  ) {
    throw new Error('application fleet does not match approval');
  }
  if (
    !generator ||
    generator.InstanceType !== infrastructure.generatorInstanceType ||
    generator.State?.Name !== 'running' ||
    !generator.PrivateIpAddress ||
    tagValue(generator, 'FastPassRunnerDigest') !==
      approval.images.runner.digest ||
    tagValue(generator, 'FastPassRunnerBuildSha') !==
      approval.images.runner.gitSha
  ) {
    throw new Error('load generator does not match approval');
  }
  if (
    expectedImage &&
    apps.some(
      (instance) =>
        tagValue(instance, 'FastPassImageDigest') !== expectedImage.digest ||
        tagValue(instance, 'FastPassBuildSha') !== expectedImage.gitSha,
    )
  ) {
    throw new Error('deployed application identity does not match approval');
  }
  const targetIds = targetHealth.TargetHealthDescriptions.map(
    (entry) => entry.Target.Id,
  );
  if (
    !sameSet(targetIds, environment.appInstanceIds) ||
    targetHealth.TargetHealthDescriptions.some(
      (entry) => entry.TargetHealth.State !== 'healthy',
    )
  ) {
    throw new Error('ALB target health does not match approval');
  }
  const targetGroup = await awsJson(region, [
    'elbv2',
    'describe-target-groups',
    '--target-group-arns',
    environment.targetGroupArn,
  ]);
  const loadBalancerArns = targetGroup.TargetGroups[0]?.LoadBalancerArns || [];
  if (loadBalancerArns.length !== 1) throw new Error('ALB identity is invalid');
  const loadBalancers = await awsJson(region, [
    'elbv2',
    'describe-load-balancers',
    '--load-balancer-arns',
    loadBalancerArns[0],
  ]);
  if (loadBalancers.LoadBalancers[0]?.Scheme !== infrastructure.albScheme) {
    throw new Error('ALB scheme does not match approval');
  }
  if (
    new URL(environment.baseUrl).hostname !==
    loadBalancers.LoadBalancers[0]?.DNSName
  ) {
    throw new Error('ALB DNS name does not match approval');
  }
  const databaseInstance = database.DBInstances[0];
  if (
    databaseInstance?.DBInstanceClass !== infrastructure.databaseClass ||
    databaseInstance?.DBInstanceStatus !== 'available' ||
    databaseInstance?.DBName !== environment.databaseName ||
    databaseInstance?.PubliclyAccessible !== false
  ) {
    throw new Error('RDS does not match approval');
  }
  const redisGroup = redis.ReplicationGroups[0];
  const redisClusterId = redisGroup?.MemberClusters?.[0];
  if (!redisClusterId) throw new Error('Redis member cluster is missing');
  const redisCluster = await awsJson(region, [
    'elasticache',
    'describe-cache-clusters',
    '--cache-cluster-id',
    redisClusterId,
  ]);
  const redisNodeType = redisCluster.CacheClusters[0]?.CacheNodeType;
  if (
    redisNodeType !== infrastructure.redisNodeType ||
    redisGroup?.Status !== 'available' ||
    redisGroup?.TransitEncryptionEnabled !== true
  ) {
    throw new Error('Redis does not match approval');
  }
  return {
    accountId: identity.Account,
    region,
    albScheme: loadBalancers.LoadBalancers[0].Scheme,
    targetGroupArn: environment.targetGroupArn,
    appInstances: apps.map((instance) => ({
      id: instance.InstanceId,
      privateIp: instance.PrivateIpAddress,
      type: instance.InstanceType,
      state: instance.State.Name,
    })),
    loadGenerator: {
      id: generator.InstanceId,
      type: generator.InstanceType,
      state: generator.State.Name,
    },
    database: {
      identifier: databaseInstance.DBInstanceIdentifier,
      class: databaseInstance.DBInstanceClass,
      status: databaseInstance.DBInstanceStatus,
      address: databaseInstance.Endpoint?.Address,
      port: databaseInstance.Endpoint?.Port,
    },
    redis: {
      id: redisGroup.ReplicationGroupId,
      clusterId: redisClusterId,
      nodeType: redisNodeType,
      status: redisGroup.Status,
      address:
        redisGroup.NodeGroups?.[0]?.PrimaryEndpoint?.Address ||
        redisGroup.ConfigurationEndpoint?.Address,
      port:
        redisGroup.NodeGroups?.[0]?.PrimaryEndpoint?.Port ||
        redisGroup.ConfigurationEndpoint?.Port,
    },
  };
}
