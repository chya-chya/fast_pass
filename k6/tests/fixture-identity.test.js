import assert from 'node:assert/strict';
import test from 'node:test';

import { transientFixtureEmail } from '../lib/fixture-identity.js';

test('transient fixture emails keep the RFC local part within 64 characters', () => {
  const email = transientFixtureEmail(
    'capacity-vu-with-a-deliberately-long-profile-name',
    999999,
    'phase12-2026-c-20261016012522065-03-vu-explore-abcdefghijklmnopqrstuvwxyz',
  );
  const [localPart, domain] = email.split('@');

  assert.ok(localPart.length <= 64);
  assert.equal(domain, 'example.invalid');
  assert.match(localPart, /^[a-z0-9-]+$/);
});

test('transient fixture emails are stable per nonce and distinct per index', () => {
  assert.equal(
    transientFixtureEmail('rps', 42, 'Run-A'),
    transientFixtureEmail('rps', 42, 'Run-A'),
  );
  assert.notEqual(
    transientFixtureEmail('rps', 42, 'Run-A'),
    transientFixtureEmail('rps', 43, 'Run-A'),
  );
  assert.notEqual(
    transientFixtureEmail('rps', 42, 'Run-A'),
    transientFixtureEmail('rps', 42, 'Run-B'),
  );
});

test('transient fixture emails reject invalid indexes', () => {
  assert.throws(
    () => transientFixtureEmail('smoke', -1, 'run'),
    /non-negative integer/,
  );
  assert.throws(
    () => transientFixtureEmail('smoke', 1.5, 'run'),
    /non-negative integer/,
  );
});
