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
  if (fixture?.schemaVersion === 2) {
    if (
      fixture.runId !== config.runId ||
      fixture.testEnvId !== config.testEnvId ||
      config.testEnvironment !== 'remote-disposable' ||
      config.redisKeyPrefix !== `k6:${config.testEnvId}:` ||
      fixture.userRange?.kind !== 'deterministic-v1' ||
      fixture.seatRange?.kind !== 'deterministic-v1' ||
      fixture.userRange.start !== 0 ||
      fixture.seatRange.start !== 0 ||
      !Number.isInteger(fixture.userRange.count) ||
      !Number.isInteger(fixture.seatRange.count) ||
      fixture.userRange.count < 1 ||
      fixture.seatRange.count < 1 ||
      fixture.userRange.count !== config.userCount ||
      fixture.seatRange.count !== config.seatCount ||
      fixture.eventId !== fixtureId(config.runId, 'event') ||
      fixture.performanceId !== fixtureId(config.runId, 'performance')
    ) {
      throw new Error('cleanup range ownership boundary does not match');
    }
    return {
      schemaVersion: 2,
      mode: 'dry-run',
      runId: config.runId,
      testEnvId: config.testEnvId,
      database: {
        reservationOwnership: { field: 'testRunId', value: config.runId },
        userRange: fixture.userRange,
        seatRange: fixture.seatRange,
        performanceId: fixture.performanceId,
        eventId: fixture.eventId,
      },
      redis: {
        runBase: `${config.redisKeyPrefix}run:${config.runId}:`,
        deterministicSeatRange: fixture.seatRange,
      },
      forbiddenOperations: [
        'wildcard',
        'truncate',
        'database-reset',
        'shared-key-delete',
      ],
    };
  }
  if (
    fixture.schemaVersion !== 1 ||
    fixture.runId !== config.runId ||
    fixture.testEnvId !== config.testEnvId ||
    !['local-disposable', 'remote-disposable'].includes(
      config.testEnvironment,
    ) ||
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
import { fixtureId } from './fixture-range.js';
