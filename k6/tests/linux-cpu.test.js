import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateLinuxCpuPercent,
  parseLinuxCpuCounters,
} from '../lib/linux-cpu.js';

test('calculates aggregate Linux host CPU instead of watchdog process CPU', () => {
  const first = parseLinuxCpuCounters('cpu  100 20 30 850 0 0 0 0 0 0\n');
  const second = parseLinuxCpuCounters('cpu  150 20 50 880 0 0 0 0 0 0\n');
  assert.equal(calculateLinuxCpuPercent(first, second), 70);
});

test('rejects missing or non-increasing aggregate CPU counters', () => {
  assert.throws(() => parseLinuxCpuCounters('cpu0 1 2 3 4 5\n'));
  assert.throws(() =>
    calculateLinuxCpuPercent(
      { total: 100, idle: 50 },
      { total: 100, idle: 50 },
    ),
  );
});
