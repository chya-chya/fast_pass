export const APP_METRIC_NAMES = Object.freeze([
  'reservation_request_total',
  'reservation_request_outcome_total',
  'reservation_lua_result_total',
  'reservation_queue_total',
  'reservation_processed_total',
  'reservation_queue_depth_messages',
  'reservation_queue_processing_messages',
  'reservation_queue_retry_messages',
  'reservation_queue_dlq_messages',
  'reservation_queue_oldest_message_age_seconds',
  'reservation_queue_metrics_collection_up',
  'reservation_queue_retry_scan_complete',
  'reservation_persistence_latency_seconds',
  'reservation_scheduler_batch_size',
  'reservation_scheduler_batch_duration_seconds',
  'process_resident_memory_bytes',
  'nodejs_heap_size_used_bytes',
  'process_start_time_seconds',
  'nodejs_eventloop_lag_seconds',
]);

const HISTOGRAM_NAMES = new Set([
  'reservation_persistence_latency_seconds',
  'reservation_scheduler_batch_size',
  'reservation_scheduler_batch_duration_seconds',
]);

function parseLabels(raw) {
  if (!raw) return {};
  const labels = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"(?:,|$)/g;
  let match;
  let consumed = 0;
  while ((match = pattern.exec(raw)) !== null) {
    labels[match[1]] = JSON.parse(`"${match[2]}"`);
    consumed = pattern.lastIndex;
  }
  if (consumed !== raw.length) throw new Error('Prometheus labels are invalid');
  return labels;
}

function selectedMetric(name) {
  if (APP_METRIC_NAMES.includes(name)) return true;
  for (const histogram of HISTOGRAM_NAMES) {
    if (
      name === `${histogram}_bucket` ||
      name === `${histogram}_sum` ||
      name === `${histogram}_count`
    ) {
      return true;
    }
  }
  return false;
}

export function parsePrometheusSnapshot(
  raw,
  capturedAt = new Date().toISOString(),
) {
  const series = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const match =
      /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{(.*)\})?\s+([^\s]+)(?:\s+\d+)?$/.exec(
        line,
      );
    if (!match || !selectedMetric(match[1])) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    series.push({
      name: match[1],
      labels: parseLabels(match[2] || ''),
      value,
    });
  }
  return { schemaVersion: 1, capturedAt, series };
}

function groupKey(labels, groupLabels) {
  return groupLabels
    .map((label) => `${label}=${labels[label] || ''}`)
    .join(',');
}

function aggregate(snapshot, name, groupLabels = [], reducer = 'sum') {
  const values = new Map();
  for (const item of snapshot.series) {
    if (item.name !== name) continue;
    const key = groupKey(item.labels, groupLabels);
    const previous = values.get(key);
    values.set(
      key,
      reducer === 'max'
        ? Math.max(previous ?? Number.NEGATIVE_INFINITY, item.value)
        : (previous || 0) + item.value,
    );
  }
  return values;
}

function delta(start, end, name, groupLabels = []) {
  const before = aggregate(start, name, groupLabels);
  const after = aggregate(end, name, groupLabels);
  const values = {};
  let resetDetected = false;
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const difference = (after.get(key) || 0) - (before.get(key) || 0);
    if (difference < 0) resetDetected = true;
    values[key || 'total'] = difference < 0 ? null : difference;
  }
  return { values, resetDetected };
}

function groupedValues(result, label) {
  return Object.fromEntries(
    Object.entries(result.values).map(([key, value]) => [
      key.replace(`${label}=`, '') || 'unknown',
      value,
    ]),
  );
}

function totalValue(result) {
  return result.values.total ?? null;
}

function gauge(snapshot, name, reducer = 'max') {
  const values = aggregate(snapshot, name, [], reducer);
  return values.get('') ?? null;
}

function histogramQuantile(buckets, quantile, total) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const target = total * quantile;
  for (const [boundary, count] of buckets) {
    if (count >= target) return boundary === '+Inf' ? null : Number(boundary);
  }
  return null;
}

function histogramWindow(start, end, name) {
  const count = delta(start, end, `${name}_count`);
  const sum = delta(start, end, `${name}_sum`);
  const bucketDelta = delta(start, end, `${name}_bucket`, ['le']);
  const buckets = Object.entries(groupedValues(bucketDelta, 'le')).sort(
    ([left], [right]) => {
      if (left === '+Inf') return 1;
      if (right === '+Inf') return -1;
      return Number(left) - Number(right);
    },
  );
  const countValue = totalValue(count);
  return {
    count: countValue,
    sum: totalValue(sum),
    p50UpperBound: histogramQuantile(buckets, 0.5, countValue),
    p95UpperBound: histogramQuantile(buckets, 0.95, countValue),
    p99UpperBound: histogramQuantile(buckets, 0.99, countValue),
    resetDetected:
      count.resetDetected || sum.resetDetected || bucketDelta.resetDetected,
  };
}

function missingMetrics(snapshot) {
  return APP_METRIC_NAMES.filter((name) => {
    if (HISTOGRAM_NAMES.has(name)) {
      return !snapshot.series.some((item) => item.name === `${name}_count`);
    }
    return !snapshot.series.some((item) => item.name === name);
  });
}

export function summarizePrometheusWindow(start, end) {
  const requests = delta(start, end, 'reservation_request_total');
  const outcomes = delta(start, end, 'reservation_request_outcome_total', [
    'outcome',
  ]);
  const luaResults = delta(start, end, 'reservation_lua_result_total', [
    'result',
  ]);
  const enqueue = delta(start, end, 'reservation_queue_total', ['status']);
  const processed = delta(start, end, 'reservation_processed_total', [
    'status',
  ]);
  const histograms = {
    persistenceLatencySeconds: histogramWindow(
      start,
      end,
      'reservation_persistence_latency_seconds',
    ),
    schedulerBatchSize: histogramWindow(
      start,
      end,
      'reservation_scheduler_batch_size',
    ),
    schedulerBatchDurationSeconds: histogramWindow(
      start,
      end,
      'reservation_scheduler_batch_duration_seconds',
    ),
  };
  const resets =
    requests.resetDetected ||
    outcomes.resetDetected ||
    luaResults.resetDetected ||
    enqueue.resetDetected ||
    processed.resetDetected ||
    Object.values(histograms).some((histogram) => histogram.resetDetected);

  return {
    capturedAt: { start: start.capturedAt, end: end.capturedAt },
    missingMetrics: [
      ...new Set([...missingMetrics(start), ...missingMetrics(end)]),
    ],
    counterResetDetected: resets,
    counters: {
      requests: totalValue(requests),
      outcomes: groupedValues(outcomes, 'outcome'),
      luaResults: groupedValues(luaResults, 'result'),
      enqueue: groupedValues(enqueue, 'status'),
      processed: groupedValues(processed, 'status'),
    },
    queue: {
      depth: gauge(end, 'reservation_queue_depth_messages'),
      processing: gauge(end, 'reservation_queue_processing_messages'),
      retry: gauge(end, 'reservation_queue_retry_messages'),
      dlq: gauge(end, 'reservation_queue_dlq_messages'),
      oldestMessageAgeSeconds: gauge(
        end,
        'reservation_queue_oldest_message_age_seconds',
      ),
      collectionUp: gauge(end, 'reservation_queue_metrics_collection_up'),
      retryScanComplete: gauge(end, 'reservation_queue_retry_scan_complete'),
    },
    histograms,
    process: {
      rssBytesSum: gauge(end, 'process_resident_memory_bytes', 'sum'),
      rssBytesMax: gauge(end, 'process_resident_memory_bytes'),
      heapBytesSum: gauge(end, 'nodejs_heap_size_used_bytes', 'sum'),
      heapBytesMax: gauge(end, 'nodejs_heap_size_used_bytes'),
      eventLoopLagSecondsMax: gauge(end, 'nodejs_eventloop_lag_seconds'),
      processStartTimeSeconds: gauge(end, 'process_start_time_seconds'),
    },
  };
}
