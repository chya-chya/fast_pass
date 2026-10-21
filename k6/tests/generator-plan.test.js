import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyGeneratorPlan } from '../tools/verify-generator-plan.mjs';

function plan(address, actions) {
  return {
    format_version: '1.2',
    resource_changes: address ? [{ address, change: { actions } }] : [],
  };
}

test('allows only creation or deletion of the temporary generator', () => {
  assert.equal(
    verifyGeneratorPlan(
      plan('aws_instance.load_generator[0]', ['create']),
      'start',
    ).change,
    'create',
  );
  assert.equal(
    verifyGeneratorPlan(
      plan('aws_instance.load_generator[0]', ['delete']),
      'stop',
    ).change,
    'delete',
  );
  assert.equal(verifyGeneratorPlan(plan(null), 'stop').change, 'none');
});

test('rejects unrelated changes and replacements', () => {
  assert.throws(
    () => verifyGeneratorPlan(plan('aws_instance.app[0]', ['update']), 'start'),
    /also change/,
  );
  assert.throws(
    () =>
      verifyGeneratorPlan(
        plan('aws_instance.load_generator[0]', ['delete', 'create']),
        'start',
      ),
    /unsafe actions/,
  );
});
