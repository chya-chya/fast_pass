import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRemoteLoadWindow } from '../lib/load-window.js';

const config = { isLocal: false, durationMs: 60_000 };
const now = Date.parse('2099-01-01T00:00:00Z');

test('remote load starts only when the remaining window covers load and grace', () => {
  assert.doesNotThrow(() =>
    assertRemoteLoadWindow(
      config,
      {
        REMOTE_APPROVAL_VERIFIED: 'true',
        REMOTE_APPROVAL_ENDS_AT: '2099-01-01T00:01:30Z',
      },
      now,
    ),
  );
  assert.throws(
    () =>
      assertRemoteLoadWindow(
        config,
        {
          REMOTE_APPROVAL_VERIFIED: 'true',
          REMOTE_APPROVAL_ENDS_AT: '2099-01-01T00:01:29Z',
        },
        now,
      ),
    /cannot cover the full load duration/,
  );
});

test('remote load rejects a missing deadline while local runs remain unchanged', () => {
  assert.throws(
    () =>
      assertRemoteLoadWindow(config, { REMOTE_APPROVAL_VERIFIED: 'true' }, now),
    /load window is invalid/,
  );
  assert.doesNotThrow(() =>
    assertRemoteLoadWindow({ isLocal: true, durationMs: 60_000 }, {}, now),
  );
});
