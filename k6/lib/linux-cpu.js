export function parseLinuxCpuCounters(raw) {
  const line = String(raw)
    .split(/\r?\n/)
    .find((candidate) => /^cpu\s/.test(candidate));
  if (!line) throw new Error('Linux aggregate CPU counters are unavailable');
  const values = line
    .trim()
    .split(/\s+/)
    .slice(1)
    .map(Number);
  if (values.length < 5 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('Linux aggregate CPU counters are invalid');
  }
  return {
    total: values.reduce((sum, value) => sum + value, 0),
    idle: values[3] + values[4],
  };
}

export function calculateLinuxCpuPercent(first, second) {
  const totalDelta = second.total - first.total;
  const idleDelta = second.idle - first.idle;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) {
    throw new Error('Linux aggregate CPU counter delta is invalid');
  }
  return ((totalDelta - idleDelta) / totalDelta) * 100;
}
