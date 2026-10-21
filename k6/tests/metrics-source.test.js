import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertQueueCollectorMetrics,
  parseMetricsUrls,
} from '../tools/metrics-source.mjs';

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

function queueSnapshot(collectionValues, retryValues = collectionValues) {
  const series = [];
  for (const [name, values] of [
    ['reservation_queue_metrics_collection_up', collectionValues],
    ['reservation_queue_retry_scan_complete', retryValues],
  ]) {
    values.forEach((value, index) => {
      series.push({
        name,
        value,
        labels: {
          instance: `i-${index}`,
          host: `host-${index}`,
          pm_id: String(index % 2),
          pid: String(1000 + index),
        },
      });
    });
  }
  return { series };
}

test('requires exactly one healthy remote queue collector for both gauges', () => {
  assert.equal(
    assertQueueCollectorMetrics(queueSnapshot([1, 0, 0]), true),
    'i-0/0/1000',
  );
  assert.throws(
    () => assertQueueCollectorMetrics(queueSnapshot([1, 1, 0]), true),
    /exactly one healthy collector/,
  );
  assert.throws(
    () => assertQueueCollectorMetrics(queueSnapshot([0, 0, 0]), true),
    /exactly one healthy collector/,
  );
  assert.throws(
    () => assertQueueCollectorMetrics(queueSnapshot([1, 0], [0, 1]), true),
    /same collector/,
  );
});

test('requires healthy queue collection and complete retry scan locally', () => {
  assert.equal(
    assertQueueCollectorMetrics(queueSnapshot([1]), false),
    'i-0/0/1000',
  );
  assert.throws(
    () => assertQueueCollectorMetrics(queueSnapshot([1], [0]), false),
    /exactly one healthy collector/,
  );
});
