import { execFile } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_PM2_OUTPUT_BYTES = 2 * 1024 * 1024;

interface Pm2Process {
  name?: unknown;
  pid?: unknown;
  pm_id?: unknown;
  pm2_env?: {
    status?: unknown;
    restart_time?: unknown;
  };
}

function labelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function finiteNonNegative(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function renderPm2Metrics(
  processes: Pm2Process[],
  instance = hostname(),
): string {
  const appProcesses = processes.filter(
    (process) => process.name === 'fast_pass',
  );
  const lines = [
    '# HELP pm2_up Whether a FastPass PM2 worker is online.',
    '# TYPE pm2_up gauge',
    '# HELP pm2_restarts Number of restarts reported by PM2.',
    '# TYPE pm2_restarts counter',
    '# HELP pm2_scrape_up Whether the PM2 process inventory was read.',
    '# TYPE pm2_scrape_up gauge',
    'pm2_scrape_up 1',
  ];
  for (const process of appProcesses) {
    const pmId = finiteNonNegative(process.pm_id);
    const pid = finiteNonNegative(process.pid);
    const restarts = finiteNonNegative(process.pm2_env?.restart_time);
    const labels = `name="fast_pass",instance="${labelValue(instance)}",pm_id="${pmId}",pid="${pid}"`;
    lines.push(
      `pm2_up{${labels}} ${process.pm2_env?.status === 'online' ? 1 : 0}`,
      `pm2_restarts{${labels}} ${restarts}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function readPm2Processes(): Promise<Pm2Process[]> {
  const result = await execFileAsync('pm2', ['jlist'], {
    encoding: 'utf8',
    maxBuffer: MAX_PM2_OUTPUT_BYTES,
    timeout: 1500,
  });
  if (Buffer.byteLength(result.stdout) > MAX_PM2_OUTPUT_BYTES) {
    throw new Error('PM2 process inventory is too large');
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed))
    throw new Error('PM2 process inventory is invalid');
  return parsed as Pm2Process[];
}

function metricsPort(): number {
  const port = Number(process.env.METRICS_PORT || 9209);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('PM2 metrics port is invalid');
  }
  return port;
}

export async function startPm2MetricsExporter(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/metrics') {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found\n');
      return;
    }
    void readPm2Processes()
      .then((processes) => {
        response.writeHead(200, {
          'Cache-Control': 'no-store',
          'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        });
        response.end(renderPm2Metrics(processes));
      })
      .catch(() => {
        response.writeHead(503, { 'Content-Type': 'text/plain' });
        response.end('metrics unavailable\n');
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(metricsPort(), '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

if (require.main === module) {
  void startPm2MetricsExporter().catch(() => {
    process.exitCode = 1;
  });
}
