import assert from 'node:assert/strict';
import test from 'node:test';

import { documentPrefix } from '../tools/remote-runner.mjs';

test('SSM document prefix follows the Terraform project name', () => {
  assert.equal(
    documentPrefix({
      environment: {
        applicationParameterName: '/fast-pass-free/aws-free-01/app',
      },
    }),
    'fast-pass-free',
  );
});

test('SSM document prefix rejects an unrelated parameter path', () => {
  assert.throws(
    () =>
      documentPrefix({
        environment: { applicationParameterName: '/fast-pass-free/other' },
      }),
    /cannot identify the Terraform environment/,
  );
});
