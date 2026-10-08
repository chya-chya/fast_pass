import {
  Body,
  ConflictException,
  Controller,
  Header,
  Headers,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  assertSafeTestId,
  assertTestEnvironmentAccess,
  testRunRedisBase,
} from './test-environment-access';

type RedisTestRunClient = {
  del(...keys: string[]): Promise<number>;
  exists(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  get(key: string): Promise<string | null>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, ...args: string[]): Promise<number>;
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    time: number,
    setMode?: 'NX',
  ): Promise<'OK' | null>;
};

type FixtureScenario =
  | 'consistency-one-seat'
  | 'consistency-inventory'
  | 'rebooking'
  | 'capacity-vu';

type FixtureInput = {
  userIds: string[];
  eventId: string;
  performanceId: string;
  seatIds: string[];
  scenario?: FixtureScenario;
  cacheProfile?: 'warm' | 'cold';
  capacityProfile?: 'unique-seat' | 'hot-seat';
  userBehavior?: 'reserve-then-think' | 'think-then-reserve';
  thinkTimeMs?: number;
  requestManifest?:
    | {
        schemaVersion: 1;
        totalRequests: number;
        assignment: 'global_iteration_modulo' | 'rebooking_sequence';
      }
    | {
        schemaVersion: 2;
        requestBudget: number;
        assignment:
          | 'global_iteration_unique_seat'
          | 'global_iteration_hot_seat';
      };
  expectedAccepted?: number;
  expectedConflicts?: number;
  requestsPerSeat?: number;
};

const ARTIFACT_TTL_SECONDS = 24 * 60 * 60;
const MAX_FIXTURE_IDS = 25_000;
const FIXTURE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function validateId(value: unknown): value is string {
  return typeof value === 'string' && FIXTURE_ID_PATTERN.test(value);
}

function validateIdArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_FIXTURE_IDS &&
    value.every(validateId) &&
    new Set(value).size === value.length
  );
}

function parseFixture(body: unknown): FixtureInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ConflictException('fixture manifest rejected');
  }
  const candidate = body as Record<string, unknown>;
  if (
    !validateIdArray(candidate.userIds) ||
    !validateId(candidate.eventId) ||
    !validateId(candidate.performanceId) ||
    !validateIdArray(candidate.seatIds)
  ) {
    throw new ConflictException('fixture manifest rejected');
  }
  const fixture: FixtureInput = {
    userIds: candidate.userIds,
    eventId: candidate.eventId,
    performanceId: candidate.performanceId,
    seatIds: candidate.seatIds,
  };
  if (candidate.scenario === undefined) return fixture;
  if (
    typeof candidate.scenario !== 'string' ||
    ![
      'consistency-one-seat',
      'consistency-inventory',
      'rebooking',
      'capacity-vu',
    ].includes(candidate.scenario) ||
    !['warm', 'cold'].includes(String(candidate.cacheProfile)) ||
    !candidate.requestManifest ||
    typeof candidate.requestManifest !== 'object' ||
    Array.isArray(candidate.requestManifest)
  ) {
    throw new ConflictException('fixture manifest rejected');
  }
  const requestManifest = candidate.requestManifest as Record<string, unknown>;
  const scenario = candidate.scenario as FixtureScenario;
  if (scenario === 'capacity-vu') {
    const capacityProfile = candidate.capacityProfile;
    const assignment = requestManifest.assignment;
    const requestBudget = requestManifest.requestBudget;
    if (
      typeof capacityProfile !== 'string' ||
      !['unique-seat', 'hot-seat'].includes(capacityProfile) ||
      typeof candidate.userBehavior !== 'string' ||
      !['reserve-then-think', 'think-then-reserve'].includes(
        candidate.userBehavior,
      ) ||
      typeof candidate.thinkTimeMs !== 'number' ||
      !Number.isInteger(candidate.thinkTimeMs) ||
      Number(candidate.thinkTimeMs) < 100 ||
      Number(candidate.thinkTimeMs) > 300_000 ||
      requestManifest.schemaVersion !== 2 ||
      typeof requestBudget !== 'number' ||
      !Number.isInteger(requestBudget) ||
      Number(requestBudget) < 1 ||
      Number(requestBudget) > MAX_FIXTURE_IDS ||
      (capacityProfile === 'unique-seat' &&
        (assignment !== 'global_iteration_unique_seat' ||
          candidate.seatIds.length !== requestBudget)) ||
      (capacityProfile === 'hot-seat' &&
        (assignment !== 'global_iteration_hot_seat' ||
          candidate.seatIds.length !== 1))
    ) {
      throw new ConflictException('fixture manifest rejected');
    }
    fixture.scenario = scenario;
    fixture.cacheProfile = candidate.cacheProfile as 'warm' | 'cold';
    fixture.capacityProfile = capacityProfile as 'unique-seat' | 'hot-seat';
    fixture.userBehavior = candidate.userBehavior as
      | 'reserve-then-think'
      | 'think-then-reserve';
    fixture.thinkTimeMs = Number(candidate.thinkTimeMs);
    fixture.requestManifest = {
      schemaVersion: 2,
      requestBudget: Number(requestBudget),
      assignment: assignment as
        | 'global_iteration_unique_seat'
        | 'global_iteration_hot_seat',
    };
    return fixture;
  }
  const totalRequests = requestManifest.totalRequests;
  if (
    requestManifest.schemaVersion !== 1 ||
    !['global_iteration_modulo', 'rebooking_sequence'].includes(
      String(requestManifest.assignment),
    ) ||
    !Number.isInteger(totalRequests) ||
    Number(totalRequests) < 1 ||
    Number(totalRequests) > 1000
  ) {
    throw new ConflictException('fixture manifest rejected');
  }
  if (
    (scenario === 'rebooking' &&
      (requestManifest.assignment !== 'rebooking_sequence' ||
        totalRequests !== 2 ||
        candidate.userIds.length !== 1 ||
        candidate.seatIds.length !== 1)) ||
    (scenario !== 'rebooking' &&
      (requestManifest.assignment !== 'global_iteration_modulo' ||
        candidate.userIds.length !== totalRequests)) ||
    (scenario === 'consistency-one-seat' && candidate.seatIds.length !== 1) ||
    (scenario === 'consistency-inventory' &&
      (candidate.seatIds.length > 50 ||
        Number(totalRequests) < candidate.seatIds.length ||
        Number(totalRequests) % candidate.seatIds.length !== 0))
  ) {
    throw new ConflictException('fixture manifest rejected');
  }
  fixture.scenario = scenario;
  fixture.cacheProfile = candidate.cacheProfile as 'warm' | 'cold';
  fixture.requestManifest = {
    schemaVersion: 1,
    totalRequests: Number(totalRequests),
    assignment: requestManifest.assignment as
      | 'global_iteration_modulo'
      | 'rebooking_sequence',
  };
  fixture.expectedAccepted =
    scenario === 'rebooking' ? 2 : candidate.seatIds.length;
  fixture.expectedConflicts =
    scenario === 'rebooking'
      ? 0
      : Number(totalRequests) - candidate.seatIds.length;
  fixture.requestsPerSeat = Number(totalRequests) / candidate.seatIds.length;
  return fixture;
}

@Controller('health/test-runs')
export class TestRunController {
  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: RedisTestRunClient,
  ) {}

  @Post(':runId/fixture')
  @Header('Cache-Control', 'no-store')
  async registerFixture(
    @Param('runId') runId: string,
    @Headers('x-test-preflight-token') token: string | undefined,
    @Body() body: unknown,
  ) {
    assertTestEnvironmentAccess(token);
    assertSafeTestId(runId, 'run ID');
    const fixture = parseFixture(body);
    const base = testRunRedisBase(runId);
    const fixtureKey = `${base}fixture`;
    const stateKey = `${base}state`;
    const countersKey = `${base}counters`;
    const now = new Date().toISOString();
    const stored = await this.redis.set(
      fixtureKey,
      JSON.stringify({ schemaVersion: 1, runId, ...fixture }),
      'EX',
      ARTIFACT_TTL_SECONDS,
      'NX',
    );
    if (stored !== 'OK') {
      throw new ConflictException('test run already exists');
    }
    await this.redis.hset(stateKey, 'producer', 'OPEN', 'createdAt', now);
    await this.redis.hset(
      countersKey,
      'enqueue',
      '0',
      'attempts',
      '0',
      'processing_started',
      '0',
      'processed_success',
      '0',
      'processed_failure',
      '0',
      'retry',
      '0',
      'dlq',
      '0',
      'worker_in_flight',
      '0',
      'max_queue_depth',
      '0',
    );
    await Promise.all([
      this.redis.expire(stateKey, ARTIFACT_TTL_SECONDS),
      this.redis.expire(countersKey, ARTIFACT_TTL_SECONDS),
    ]);
    return { runId, producerState: 'OPEN' };
  }

  @Post(':runId/cache-profile')
  @Header('Cache-Control', 'no-store')
  async applyCacheProfile(
    @Param('runId') runId: string,
    @Headers('x-test-preflight-token') token: string | undefined,
  ) {
    assertTestEnvironmentAccess(token);
    assertSafeTestId(runId, 'run ID');
    const base = testRunRedisBase(runId);
    const fixtureText = await this.redis.get(`${base}fixture`);
    if (
      !fixtureText ||
      (await this.redis.hget(`${base}state`, 'producer')) !== 'OPEN'
    ) {
      throw new ConflictException('fixture manifest is missing or closed');
    }
    let fixture: FixtureInput;
    try {
      fixture = JSON.parse(fixtureText) as FixtureInput;
    } catch {
      throw new ConflictException('fixture manifest is invalid');
    }
    if (
      !fixture.scenario ||
      !fixture.cacheProfile ||
      !validateIdArray(fixture.seatIds)
    ) {
      throw new ConflictException('cache profile is unavailable');
    }
    const keys = fixture.seatIds.map((seatId) => `seat:${seatId}:status`);
    if (fixture.cacheProfile === 'warm') {
      await Promise.all(
        keys.map((key) => this.redis.set(key, 'AVAILABLE', 'EX', 600)),
      );
    } else {
      await this.redis.del(...keys);
    }
    const values = await this.redis.mget(...keys);
    const verified =
      fixture.cacheProfile === 'warm'
        ? values.every((value) => value === 'AVAILABLE')
        : values.every((value) => value === null);
    if (!verified)
      throw new ConflictException('cache profile verification failed');
    await this.redis.hset(
      `${base}state`,
      'cache_profile',
      fixture.cacheProfile,
      'cacheProfileAppliedAt',
      new Date().toISOString(),
    );
    await this.redis.expire(`${base}state`, ARTIFACT_TTL_SECONDS);
    return {
      runId,
      cacheProfile: fixture.cacheProfile,
      seatCount: fixture.seatIds.length,
      verified: true,
    };
  }

  @Post(':runId/producer-complete')
  @Header('Cache-Control', 'no-store')
  async producerComplete(
    @Param('runId') runId: string,
    @Headers('x-test-preflight-token') token: string | undefined,
  ) {
    assertTestEnvironmentAccess(token);
    assertSafeTestId(runId, 'run ID');
    const base = testRunRedisBase(runId);
    const fixtureKey = `${base}fixture`;
    const stateKey = `${base}state`;
    if ((await this.redis.exists(fixtureKey)) !== 1) {
      throw new ConflictException('fixture manifest is missing');
    }
    if ((await this.redis.hget(stateKey, 'producer')) !== 'OPEN') {
      throw new ConflictException('producer state rejected');
    }
    await this.redis.hset(
      stateKey,
      'producer',
      'COMPLETED',
      'completedAt',
      new Date().toISOString(),
    );
    await this.redis.expire(stateKey, ARTIFACT_TTL_SECONDS);
    return { runId, producerState: 'COMPLETED' };
  }
}
