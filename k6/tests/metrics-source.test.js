import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMetricsUrls } from '../tools/metrics-source.mjs';

test('accepts only exact private worker metric URLs', () => {
  const urls = Array.from(
    { length: 14 },
    (_, index) =>
      `http://10.42.${Math.floor(index / 2)}.${index + 10}:${9300 + (index % 2)}/metrics`,
  );
  assert.equal(
    parseMetricsUrls('WORKER_METRICS_URLS', urls.join(','), 14, [9300, 9301])
      .length,
    14,
  );
  assert.throws(
    () =>
      parseMetricsUrls(
        'WORKER_METRICS_URLS',
        urls.slice(0, 13).join(','),
        14,
        [9300, 9301],
      ),
    /exactly 14/,
  );
  assert.throws(
    () =>
      parseMetricsUrls(
        'WORKER_METRICS_URLS',
        `${urls.slice(0, 13).join(',')},http://8.8.8.8:9301/metrics`,
        14,
        [9300, 9301],
      ),
    /private metrics boundary/,
  );
});
