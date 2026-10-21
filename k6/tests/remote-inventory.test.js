import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAwsJson } from '../tools/remote-inventory.mjs';

test('parses a normal AWS JSON response', () => {
  assert.deepEqual(parseAwsJson('{"ok":true}\n'), { ok: true });
});

test('allows an empty AWS response only when explicitly requested', () => {
  assert.deepEqual(parseAwsJson('', { allowEmpty: true }), {});
  assert.throws(() => parseAwsJson(''), /empty JSON response/);
});
