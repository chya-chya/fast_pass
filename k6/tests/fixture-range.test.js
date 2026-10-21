import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fixtureEmail,
  fixtureId,
  rangeAssignment,
} from '../lib/fixture-range.js';

test('deterministically calculates one million fixture IDs without arrays', () => {
  const runId = 'remote-soak-001';
  assert.equal(fixtureId(runId, 'seat', 0), 'remote-soak-001-seat-00000000');
  assert.equal(
    fixtureId(runId, 'seat', 999_999),
    'remote-soak-001-seat-00999999',
  );
  assert.equal(
    rangeAssignment(999_999, runId, 325, 1_000_000).userId,
    fixtureId(runId, 'user', 999_999 % 325),
  );
  const email = fixtureEmail(runId, 4);
  assert.equal(email, fixtureEmail(runId, 4));
  assert.equal(email.endsWith('-00000004@load.invalid'), true);
  assert.ok(email.split('@')[0].length <= 64);
});

test('keeps maximum-length run IDs within the email local-part limit', () => {
  const email = fixtureEmail(`r${'a'.repeat(62)}z`, 99_999_999);
  assert.ok(email.split('@')[0].length <= 64);
  assert.notEqual(email, fixtureEmail(`r${'a'.repeat(61)}bz`, 99_999_999));
});

test('rejects an index outside the approved range', () => {
  assert.throws(() => rangeAssignment(10, 'remote-soak-001', 2, 10), /invalid/);
});
