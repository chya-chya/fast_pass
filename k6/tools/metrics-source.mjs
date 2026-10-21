import { parsePrometheusSnapshot } from '../lib/prometheus.js';

const MAX_METRICS_BYTES = 2 * 1024 * 1024;
const QUEUE_HEALTH_METRICS = Object.freeze([
  'reservation_queue_metrics_collection_up',
  'reservation_queue_retry_scan_complete',
]);

function workerIdentity(series, remote) {
  const instance = remote
    ? series.labels.instance
    : series.labels.instance || series.labels.host;
  const pmId = series.labels.pm_id;
  const pid = series.labels.pid;
  if (!instance || !pmId || !pid) {
    throw new Error('queue collector worker identity is missing');
  }
  return `${instance}/${pmId}/${pid}`;
}

export function assertQueueCollectorMetrics(snapshot, remote = false) {
  let collectorIdentity = null;
  for (const name of QUEUE_HEALTH_METRICS) {
    const series = snapshot.series.filter((item) => item.name === name);
    if (series.some((item) => ![0, 1].includes(item.value))) {
      throw new Error(`${name} must be a binary gauge`);
    }
    const healthy = series.filter((item) => item.value === 1);
    if (healthy.length !== 1) {
      throw new Error(`${name} must identify exactly one healthy collector`);
    }
    const identity = workerIdentity(healthy[0], remote);
    if (collectorIdentity !== null && collectorIdentity !== identity) {
      throw new Error('queue health gauges must come from the same collector');
    }
    collectorIdentity = identity;
  }
  return collectorIdentity;
}

function isPrivateIpv4(hostname) {
  const parts = hostname.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

export function parseMetricsUrls(name, raw, expectedCount, allowedPorts) {
  const values = (raw || '').split(',').filter(Boolean);
  if (
    values.length !== expectedCount ||
    new Set(values).size !== values.length
  ) {
    throw new Error(
      `${name} must contain exactly ${expectedCount} unique URLs`,
    );
  }
  return values.map((value) => {
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      !isPrivateIpv4(url.hostname) ||
      !allowedPorts.includes(Number(url.port)) ||
      url.pathname !== '/metrics' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error(
        `${name} contains a URL outside the private metrics boundary`,
      );
    }
    return url.href;
  });
}

async function fetchSnapshot(url) {
  const response = await fetch(url, {
    headers: { Accept: 'text/plain' },
    redirect: 'error',
    signal: AbortSignal.timeout(2000),
  });
  if (response.status !== 200) throw new Error('metrics endpoint rejected');
  const raw = await response.text();
  if (Buffer.byteLength(raw) > MAX_METRICS_BYTES) {
    throw new Error('metrics response is too large');
  }
  const snapshot = parsePrometheusSnapshot(raw);
  if (snapshot.series.length === 0)
    throw new Error('metrics endpoint is empty');
  return snapshot;
}

export async function collectApplicationSnapshot(config, env = process.env) {
  if (config.isLocal) return fetchSnapshot(`${config.baseUrl}/metrics`);
  const urls = parseMetricsUrls(
    'WORKER_METRICS_URLS',
    env.WORKER_METRICS_URLS,
    14,
    [9300, 9301],
  );
  const snapshots = await Promise.all(urls.map(fetchSnapshot));
  const identities = new Set();
  for (const snapshot of snapshots) {
    const identitySeries = snapshot.series.find(
      (series) =>
        series.labels.instance && series.labels.pm_id && series.labels.pid,
    );
    if (!identitySeries) throw new Error('worker metrics identity is missing');
    const identity = `${identitySeries.labels.instance}/${identitySeries.labels.pm_id}`;
    if (identities.has(identity))
      throw new Error('worker metrics identity is duplicated');
    identities.add(identity);
  }
  return {
    comments: snapshots.flatMap((snapshot) => snapshot.comments || []),
    series: snapshots.flatMap((snapshot) => snapshot.series),
  };
}

export async function collectPm2Snapshots(env = process.env) {
  const urls = parseMetricsUrls(
    'PM2_METRICS_URLS',
    env.PM2_METRICS_URLS,
    7,
    [9209],
  );
  return Promise.all(urls.map(fetchSnapshot));
}
