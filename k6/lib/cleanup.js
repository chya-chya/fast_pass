function uniqueSafeIds(values, label) {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string')
  ) {
    throw new Error(`${label} must be an ID array`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicate IDs`);
  }
  if (values.some((value) => !/^[A-Za-z0-9_-]{1,128}$/.test(value))) {
    throw new Error(`${label} contains an unsafe ID`);
  }
  return [...values].sort();
}

export function buildCleanupPlan(config, fixture) {
  if (
    fixture.schemaVersion !== 1 ||
    fixture.runId !== config.runId ||
    fixture.testEnvId !== config.testEnvId ||
    config.testEnvironment !== 'local-disposable' ||
    config.redisKeyPrefix !== `k6:${config.testEnvId}:`
  ) {
    throw new Error('cleanup ownership boundary does not match');
  }
  const userIds = uniqueSafeIds(fixture.userIds, 'user IDs');
  const eventIds = uniqueSafeIds(fixture.eventIds, 'event IDs');
  const performanceIds = uniqueSafeIds(
    fixture.performanceIds,
    'performance IDs',
  );
  const seatIds = uniqueSafeIds(fixture.seatIds, 'seat IDs');
  const reservationIds = uniqueSafeIds(
    fixture.reservationIds,
    'reservation IDs',
  );
  const base = `${config.redisKeyPrefix}run:${config.runId}:`;
  const runKeys = [
    'fixture',
    'state',
    'counters',
    'accepted',
    'processing',
    'processed',
    'failed',
    'requests',
  ].map((suffix) => `${base}${suffix}`);
  const seatKeys = seatIds.flatMap((seatId) => [
    `seat:${seatId}:status`,
    `locks:seats:${seatId}`,
  ]);
  return {
    schemaVersion: 1,
    mode: 'dry-run',
    runId: config.runId,
    testEnvId: config.testEnvId,
    database: {
      reservationIds,
      seatIds,
      performanceIds,
      eventIds,
      userIds,
    },
    redis: { keys: [...runKeys, ...seatKeys].sort() },
    forbiddenOperations: [
      'wildcard',
      'truncate',
      'database-reset',
      'shared-key-delete',
    ],
  };
}
