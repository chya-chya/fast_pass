import { createServer, Server } from 'node:http';
import { hostname } from 'node:os';
import { register } from 'prom-client';

const MIN_PORT = 1024;
const MAX_PORT = 65535;

function workerMetricPort(): number {
  const base = Number(process.env.WORKER_METRICS_BASE_PORT || 9300);
  const instance = Number(
    process.env.NODE_APP_INSTANCE || process.env.pm_id || 0,
  );
  if (
    !Number.isInteger(base) ||
    !Number.isInteger(instance) ||
    instance < 0 ||
    instance > 63 ||
    base < MIN_PORT ||
    base + instance > MAX_PORT
  ) {
    throw new Error('worker metrics port configuration is invalid');
  }
  return base + instance;
}

export async function startWorkerMetricsServer(): Promise<Server | null> {
  if (process.env.WORKER_METRICS_ENABLED !== 'true') return null;

  const appInstance = process.env.NODE_APP_INSTANCE || '0';
  register.setDefaultLabels({
    host: hostname(),
    instance: process.env.INSTANCE_ID || hostname(),
    app_instance: appInstance,
    pm_id: process.env.pm_id || appInstance,
    pid: String(process.pid),
    generation:
      process.env.PM2_WORKER_GENERATION || process.env.restart_time || '0',
  });

  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found\n');
      return;
    }
    void register
      .metrics()
      .then((metrics) => {
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': register.contentType,
        });
        response.end(metrics);
      })
      .catch(() => {
        response.writeHead(503, { 'Content-Type': 'text/plain' });
        response.end('metrics unavailable\n');
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(workerMetricPort(), '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}
