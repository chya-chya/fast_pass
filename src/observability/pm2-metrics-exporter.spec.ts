import { renderPm2Metrics } from './pm2-metrics-exporter';

describe('PM2 metrics exporter', () => {
  it('reports online state and restart totals for FastPass workers only', () => {
    const metrics = renderPm2Metrics(
      [
        {
          name: 'fast_pass',
          pid: 101,
          pm_id: 0,
          pm2_env: { status: 'online', restart_time: 2 },
        },
        {
          name: 'fast_pass',
          pid: 102,
          pm_id: 1,
          pm2_env: { status: 'stopped', restart_time: 3 },
        },
        { name: 'pm2-metrics-exporter', pid: 103, pm_id: 2 },
      ],
      'app-01',
    );

    expect(metrics).toContain(
      'pm2_up{name="fast_pass",instance="app-01",pm_id="0",pid="101"} 1',
    );
    expect(metrics).toContain(
      'pm2_up{name="fast_pass",instance="app-01",pm_id="1",pid="102"} 0',
    );
    expect(metrics).toContain('pm2_restarts{');
    expect(metrics).not.toContain('name="pm2-metrics-exporter"');
  });

  it('escapes instance labels and never emits non-finite values', () => {
    const metrics = renderPm2Metrics(
      [
        {
          name: 'fast_pass',
          pid: Number.NaN,
          pm_id: -1,
          pm2_env: { status: 'online', restart_time: Number.POSITIVE_INFINITY },
        },
      ],
      'host"\\line\nnext',
    );

    expect(metrics).toContain('instance="host\\"\\\\line\\nnext"');
    expect(metrics).not.toContain('NaN');
    expect(metrics).not.toContain('Infinity');
  });
});
