import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parsePrometheusSnapshot,
  summarizePrometheusWindow,
} from '../lib/prometheus.js';

const labels =
  'host="host-1",app_instance="0",pm_id="0",pid="10",worker_generation="0"';

function snapshot(requests, accepted, histogramCount, histogramSum) {
  return parsePrometheusSnapshot(
    [
      `reservation_request_total{${labels}} ${requests}`,
      `reservation_request_outcome_total{outcome="accepted",${labels}} ${accepted}`,
      `reservation_queue_total{status="success",${labels}} ${accepted}`,
      `reservation_processed_total{status="success",${labels}} ${accepted}`,
      `reservation_lua_result_total{result="OK",${labels}} ${accepted}`,
      `reservation_persistence_latency_seconds_bucket{le="0.1",${labels}} 0`,
      `reservation_persistence_latency_seconds_bucket{le="1",${labels}} ${histogramCount}`,
      `reservation_persistence_latency_seconds_bucket{le="+Inf",${labels}} ${histogramCount}`,
      `reservation_persistence_latency_seconds_sum{${labels}} ${histogramSum}`,
      `reservation_persistence_latency_seconds_count{${labels}} ${histogramCount}`,
      `reservation_queue_depth_messages{${labels}} 0`,
      `reservation_queue_processing_messages{${labels}} 0`,
      `reservation_queue_retry_messages{${labels}} 0`,
      `reservation_queue_dlq_messages{${labels}} 0`,
      `reservation_queue_oldest_message_age_seconds{${labels}} 0`,
      `reservation_queue_metrics_collection_up{${labels}} 1`,
      `reservation_queue_retry_scan_complete{${labels}} 1`,
      `process_resident_memory_bytes{${labels}} 100`,
      `nodejs_heap_size_used_bytes{${labels}} 50`,
      `process_start_time_seconds{${labels}} 1`,
      `nodejs_eventloop_lag_seconds{${labels}} 0.01`,
    ].join('\n'),
  );
}

test('summarizes counter deltas, gauges, and histogram bounds', () => {
  const result = summarizePrometheusWindow(
    snapshot(10, 8, 8, 4),
    snapshot(13, 11, 11, 5.5),
  );

  assert.equal(result.counters.requests, 3);
  assert.equal(result.counters.outcomes.accepted, 3);
  assert.equal(result.counters.enqueue.success, 3);
  assert.equal(result.histograms.persistenceLatencySeconds.count, 3);
  assert.equal(result.histograms.persistenceLatencySeconds.sum, 1.5);
  assert.equal(result.histograms.persistenceLatencySeconds.p95UpperBound, 1);
  assert.equal(result.queue.collectionUp, 1);
  assert.equal(result.process.rssBytesSum, 100);
  assert.equal(result.counterResetDetected, false);
});

test('detects counter resets instead of reporting a negative delta', () => {
  const result = summarizePrometheusWindow(
    snapshot(10, 8, 8, 4),
    snapshot(1, 1, 1, 0.5),
  );
  assert.equal(result.counters.requests, null);
  assert.equal(result.counterResetDetected, true);
});
