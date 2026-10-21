import assert from 'node:assert/strict';
import test from 'node:test';

import { bitmapIndicesFromBytes } from '../lib/redis-bitmap.js';

test('decodes Redis SETBIT offsets in network bit order', () => {
  assert.deepEqual(
    bitmapIndicesFromBytes(Uint8Array.from([0b10000001, 0b01000000])),
    [0, 7, 9],
  );
});

test('accepts a missing or empty bitmap and rejects non-bytes', () => {
  assert.deepEqual(bitmapIndicesFromBytes(null), []);
  assert.deepEqual(bitmapIndicesFromBytes(new Uint8Array()), []);
  assert.throws(() => bitmapIndicesFromBytes('not-bytes'), /byte array/);
});
