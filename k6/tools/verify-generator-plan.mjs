#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const GENERATOR_ADDRESS = 'aws_instance.load_generator[0]';

export function verifyGeneratorPlan(plan, operation) {
  if (!['start', 'stop'].includes(operation)) {
    throw new Error('operation must be start or stop');
  }
  if (!plan || plan.format_version === undefined) {
    throw new Error('Terraform plan JSON is invalid');
  }

  const material = (plan.resource_changes || []).filter((change) => {
    const actions = change.change?.actions || [];
    return !(actions.length === 1 && ['no-op', 'read'].includes(actions[0]));
  });
  const unexpected = material.filter(
    (change) => change.address !== GENERATOR_ADDRESS,
  );
  if (unexpected.length > 0) {
    throw new Error(
      `generator plan would also change: ${unexpected
        .map((change) => change.address)
        .join(', ')}`,
    );
  }
  if (material.length === 0) {
    return Object.freeze({ operation, change: 'none' });
  }

  const actions = material[0].change?.actions || [];
  const expected = operation === 'start' ? ['create'] : ['delete'];
  if (
    actions.length !== expected.length ||
    actions.some((action, index) => action !== expected[index])
  ) {
    throw new Error(
      `generator ${operation} plan has unsafe actions: ${actions.join(',')}`,
    );
  }
  return Object.freeze({ operation, change: expected[0] });
}

async function main() {
  const [, , filePath, operation] = process.argv;
  if (!filePath || !operation || process.argv.length !== 4) {
    throw new Error(
      'usage: verify-generator-plan.mjs <terraform-plan.json> start|stop',
    );
  }
  const plan = JSON.parse(await readFile(filePath, 'utf8'));
  process.stdout.write(
    `${JSON.stringify(verifyGeneratorPlan(plan, operation))}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`generator plan rejected: ${error.message}\n`);
    process.exitCode = 1;
  });
}
