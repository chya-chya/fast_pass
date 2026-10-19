const SCENARIO_ORDER = Object.freeze([
  'smoke',
  'consistency-inventory',
  'capacity-vu',
  'capacity-rps',
  'spike',
  'soak',
]);

function assertIncreasing(values, label) {
  if (values.some((value, index) => index > 0 && value <= values[index - 1])) {
    throw new Error(`${label} must be strictly increasing`);
  }
}

function durationSeconds(run) {
  const env = run.env;
  if (run.scenario === 'capacity-vu') {
    return (
      Number(env.CAPACITY_RAMP_DURATION.slice(0, -1)) * 5 +
      [1, 2, 3, 4].reduce(
        (total, index) =>
          total + Number(env[`CAPACITY_STAGE_HOLD_${index}`].slice(0, -1)),
        0,
      )
    );
  }
  if (run.scenario === 'capacity-rps' && env.RPS_TEST_PROFILE === 'explore') {
    return (
      Number(env.RPS_RAMP_DURATION.slice(0, -1)) * 5 +
      [1, 2, 3, 4].reduce(
        (total, index) =>
          total + Number(env[`RPS_STAGE_HOLD_${index}`].slice(0, -1)),
        0,
      )
    );
  }
  if (run.scenario === 'capacity-rps')
    return Number(env.RPS_DURATION.slice(0, -1));
  if (run.scenario === 'spike') {
    return [
      'SPIKE_BASELINE_DURATION',
      'SPIKE_PEAK_DURATION',
      'SPIKE_RECOVERY_DURATION',
    ].reduce((total, key) => total + Number(env[key].slice(0, -1)), 0);
  }
  if (run.scenario === 'soak') return Number(env.SOAK_DURATION.slice(0, -1));
  return Number(env.DURATION.slice(0, -1));
}

function safeRunPrefix(approvalId, role) {
  return `${approvalId.slice(0, 12)}-${role[0]}`.replace(
    /[^A-Za-z0-9._-]/g,
    '-',
  );
}

function pushIfAllowed(runs, allowed, run) {
  if (allowed.has(run.scenario)) runs.push(run);
}

function buildImageRuns(approval, imageRole, timestamp) {
  const { execution: profile, limits } = approval;
  const allowed = new Set(approval.scenarios);
  const prefix = safeRunPrefix(approval.approvalId, imageRole);
  let sequence = 0;
  const nextId = (purpose) =>
    `${prefix}-${timestamp}-${String(++sequence).padStart(2, '0')}-${purpose}`;
  const runs = [];
  const rangeFixtureEnv = {
    FIXTURE_SEED_MODE: 'chunked-bulk',
    FIXTURE_MAX_USERS: String(limits.maxFixtureUsers),
    FIXTURE_MAX_SEATS: String(limits.maxFixtureSeats),
    FIXTURE_MAX_DATABASE_ROWS: String(limits.maxFixtureDatabaseRows),
    FIXTURE_MAX_DATABASE_BYTES: String(limits.maxFixtureDatabaseBytes),
    FIXTURE_MAX_REDIS_BYTES: String(limits.maxFixtureRedisBytes),
    FIXTURE_MAX_STORAGE_BYTES: String(limits.maxFixtureDatabaseBytes),
  };

  pushIfAllowed(runs, allowed, {
    runId: nextId('smoke'),
    scenario: 'smoke',
    purpose: 'NON_QUALIFYING_SMOKE',
    qualifying: false,
    env: {
      ...rangeFixtureEnv,
      VU: String(profile.smokeVus),
      USER_COUNT: String(profile.smokeVus),
      SEAT_COUNT: String(Math.max(5, profile.smokeVus)),
      DURATION: `${profile.smokeDurationSeconds}s`,
    },
    approvedRequests: profile.smokeVus,
  });

  pushIfAllowed(runs, allowed, {
    runId: nextId('consistency'),
    scenario: 'consistency-inventory',
    purpose: 'SCALED_CONSISTENCY',
    qualifying: false,
    env: {
      ...rangeFixtureEnv,
      VU: String(profile.consistencyVus),
      USER_COUNT: String(profile.consistencyVus),
      SEAT_COUNT: String(profile.consistencySeats),
      DURATION: '60s',
    },
    approvedRequests: profile.consistencyVus,
  });

  const vuEnv = {
    ...rangeFixtureEnv,
    CAPACITY_VU_STAGES: profile.capacityVuStages.join(','),
    CAPACITY_RAMP_DURATION: `${profile.capacityVuRampSeconds}s`,
    CAPACITY_THINK_TIME: `${profile.capacityVuThinkSeconds}s`,
    CAPACITY_REQUEST_BUDGET: String(profile.capacityVuRequestBudget),
    USER_COUNT: String(Math.max(...profile.capacityVuStages)),
    SEAT_COUNT: String(profile.capacityVuRequestBudget),
  };
  profile.capacityVuStages.forEach((_, index) => {
    vuEnv[`CAPACITY_STAGE_HOLD_${index + 1}`] =
      `${profile.capacityVuHoldSeconds}s`;
  });
  pushIfAllowed(runs, allowed, {
    runId: nextId('vu-explore'),
    scenario: 'capacity-vu',
    purpose: 'VU_EXPLORATION',
    qualifying: false,
    env: vuEnv,
    approvedRequests: profile.capacityVuRequestBudget,
  });

  const rpsBase = {
    ...rangeFixtureEnv,
    RPS_RATE: String(profile.stableRps),
    RPS_PRE_ALLOCATED_VUS: String(profile.preAllocatedVus),
    RPS_MAX_VUS: String(profile.maxVus),
    RPS_REQUEST_BUDGET: String(profile.rpsRequestBudget),
    USER_COUNT: String(profile.maxVus),
    SEAT_COUNT: String(profile.rpsRequestBudget),
  };
  const rpsExplore = {
    ...rpsBase,
    RPS_TEST_PROFILE: 'explore',
    RPS_STAGES: profile.rpsExploreStages.join(','),
    RPS_RAMP_DURATION: `${profile.rpsRampSeconds}s`,
  };
  profile.rpsExploreStages.forEach((_, index) => {
    rpsExplore[`RPS_STAGE_HOLD_${index + 1}`] = `${profile.rpsHoldSeconds}s`;
  });
  pushIfAllowed(runs, allowed, {
    runId: nextId('rps-explore'),
    scenario: 'capacity-rps',
    purpose: 'RPS_EXPLORATION',
    qualifying: false,
    env: rpsExplore,
    approvedRequests: profile.rpsRequestBudget,
  });

  for (const [profileName, repeats] of [
    ['confirm-50', 1],
    ['confirm-75', 1],
    ['confirm-100', 3],
  ]) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      pushIfAllowed(runs, allowed, {
        runId: nextId(`${profileName}-${repeat}`),
        scenario: 'capacity-rps',
        purpose: profileName.toUpperCase(),
        qualifying: true,
        env: {
          ...rpsBase,
          RPS_TEST_PROFILE: profileName,
          RPS_DURATION: `${profile.rpsConfirmationSeconds}s`,
        },
        approvedRequests: profile.rpsRequestBudget,
      });
    }
  }
  if (profile.allowOverload110) {
    pushIfAllowed(runs, allowed, {
      runId: nextId('confirm-110'),
      scenario: 'capacity-rps',
      purpose: 'OVERLOAD_110_EXPLORATION',
      qualifying: false,
      env: {
        ...rpsBase,
        RPS_TEST_PROFILE: 'confirm-110',
        RPS_DURATION: `${profile.rpsConfirmationSeconds}s`,
      },
      approvedRequests: profile.rpsRequestBudget,
    });
  }

  const longestRunSeconds = Math.max(
    profile.soakDurationSeconds,
    profile.spikeBaselineSeconds +
      profile.spikePeakSeconds +
      profile.spikeRecoverySeconds,
  );
  const tokenTtlHours = Math.max(
    2,
    Math.ceil((longestRunSeconds + 42 * 60) / 3600),
  );
  const longCommon = {
    ...rangeFixtureEnv,
    LOAD_PRE_ALLOCATED_VUS: String(profile.preAllocatedVus),
    LOAD_MAX_VUS: String(profile.maxVus),
    USER_COUNT: String(profile.maxVus),
    LOAD_ACCESS_TOKEN_TTL: `${tokenTtlHours}h`,
  };
  const spikeRequests = Math.ceil(
    (profile.spikeBaselineRps *
      (profile.spikeBaselineSeconds + profile.spikeRecoverySeconds) +
      profile.spikePeakRps * profile.spikePeakSeconds) *
      1.1,
  );
  pushIfAllowed(runs, allowed, {
    runId: nextId('spike'),
    scenario: 'spike',
    purpose: 'SPIKE_QUALIFICATION',
    qualifying: true,
    env: {
      ...longCommon,
      SPIKE_BASELINE_RPS: String(profile.spikeBaselineRps),
      SPIKE_PEAK_RPS: String(profile.spikePeakRps),
      SPIKE_BASELINE_DURATION: `${profile.spikeBaselineSeconds}s`,
      SPIKE_PEAK_DURATION: `${profile.spikePeakSeconds}s`,
      SPIKE_RECOVERY_DURATION: `${profile.spikeRecoverySeconds}s`,
      LOAD_REQUEST_BUDGET: String(spikeRequests),
      SEAT_COUNT: String(spikeRequests),
    },
    approvedRequests: spikeRequests,
  });

  const soakRps = Math.ceil(
    (profile.stableRps * profile.soakRatePercent) / 100,
  );
  const soakRequests = Math.ceil(soakRps * profile.soakDurationSeconds * 1.1);
  const lastConfirmation = [...runs]
    .reverse()
    .find((run) => run.purpose === 'CONFIRM-100');
  pushIfAllowed(runs, allowed, {
    runId: nextId('soak'),
    scenario: 'soak',
    purpose: 'SOAK_QUALIFICATION',
    qualifying: true,
    env: {
      ...longCommon,
      CONFIRMED_SUSTAINABLE_RPS: String(profile.stableRps),
      CONFIRMED_CAPACITY_RUN_ID:
        lastConfirmation?.runId || 'missing-confirmation',
      SOAK_RATE_PERCENT: String(profile.soakRatePercent),
      SOAK_DURATION: `${profile.soakDurationSeconds}s`,
      LOAD_REQUEST_BUDGET: String(soakRequests),
      SEAT_COUNT: String(soakRequests),
    },
    approvedRequests: soakRequests,
  });

  return runs.map((run) => ({
    ...run,
    imageRole,
    durationSeconds: durationSeconds(run),
  }));
}

export function validateExecutionProfile(approval) {
  const { execution: profile, limits } = approval;
  assertIncreasing(profile.capacityVuStages, 'capacity VU stages');
  assertIncreasing(profile.rpsExploreStages, 'RPS exploration stages');
  if (profile.consistencyVus % profile.consistencySeats !== 0) {
    throw new Error('consistency VUs must be evenly divisible by seats');
  }
  if (
    profile.preAllocatedVus > profile.maxVus ||
    profile.maxVus > limits.maxVus
  ) {
    throw new Error('execution VU allocation exceeds approval');
  }
  if (
    Math.max(...profile.capacityVuStages) > limits.maxVus ||
    Math.max(
      ...profile.rpsExploreStages,
      profile.stableRps,
      profile.spikePeakRps,
    ) > limits.maxRps ||
    profile.spikeBaselineRps >= profile.spikePeakRps
  ) {
    throw new Error('execution load exceeds approval or has an invalid spike');
  }
  if (
    profile.capacityVuRequestBudget > limits.maxRequests ||
    profile.rpsRequestBudget > limits.maxRequests
  ) {
    throw new Error('capacity request budget exceeds approval');
  }
  if (
    (approval.scenarios.includes('spike') ||
      approval.scenarios.includes('soak')) &&
    !approval.scenarios.includes('capacity-rps')
  ) {
    throw new Error('Spike and Soak require approved RPS confirmation runs');
  }
  if (
    profile.allowOverload110 &&
    Math.ceil(profile.stableRps * 1.1) > limits.maxRps
  ) {
    throw new Error('110 percent exploration exceeds approved RPS');
  }
  if (
    Math.ceil(
      (Math.max(
        profile.soakDurationSeconds,
        profile.spikeBaselineSeconds +
          profile.spikePeakSeconds +
          profile.spikeRecoverySeconds,
      ) +
        42 * 60) /
        3600,
    ) > 24
  ) {
    throw new Error(
      'approved long run cannot fit the maximum access-token TTL',
    );
  }
  const spikeBudget = Math.ceil(
    (profile.spikeBaselineRps *
      (profile.spikeBaselineSeconds + profile.spikeRecoverySeconds) +
      profile.spikePeakRps * profile.spikePeakSeconds) *
      1.1,
  );
  const soakBudget = Math.ceil(
    Math.ceil((profile.stableRps * profile.soakRatePercent) / 100) *
      profile.soakDurationSeconds *
      1.1,
  );
  const largestLongRunBudget = Math.max(spikeBudget, soakBudget);
  if (
    largestLongRunBudget > limits.maxRequests ||
    largestLongRunBudget > limits.maxFixtureSeats ||
    profile.maxVus + largestLongRunBudget * 2 + 2 >
      limits.maxFixtureDatabaseRows ||
    largestLongRunBudget * 512 > limits.maxFixtureDatabaseBytes ||
    largestLongRunBudget * 256 > limits.maxFixtureRedisBytes
  ) {
    throw new Error('long-run fixture capacity exceeds approval');
  }
  const normalized = [...approval.scenarios].sort();
  if (normalized.some((value) => !SCENARIO_ORDER.includes(value))) {
    throw new Error('approval contains an unknown scenario');
  }
}

export function buildRemoteExecutionMatrix(
  approval,
  now = new Date(),
  executionTimestamp = now.toISOString().replace(/\D/g, '').slice(0, 17),
) {
  validateExecutionProfile(approval);
  if (!/^\d{17}$/.test(executionTimestamp)) {
    throw new Error('execution timestamp is invalid');
  }
  const timestamp = executionTimestamp;
  const imageRoles =
    approval.mode.kind === 'comparison'
      ? ['baseline', 'candidate']
      : ['candidate'];
  const matrix = imageRoles.flatMap((role) =>
    buildImageRuns(approval, role, timestamp),
  );
  for (const run of matrix) {
    if (
      run.qualifying &&
      run.durationSeconds < approval.abort.consecutiveSamples * 60
    ) {
      throw new Error(
        `${run.runId} is too short for ${approval.abort.consecutiveSamples} independent one-minute CloudWatch observations`,
      );
    }
    if (
      run.durationSeconds > approval.limits.maxDurationSeconds ||
      run.approvedRequests > approval.limits.maxRequests ||
      Number(run.env.USER_COUNT) > approval.limits.maxFixtureUsers ||
      Number(run.env.SEAT_COUNT) > approval.limits.maxFixtureSeats
    ) {
      throw new Error(
        `${run.runId} exceeds an approved execution or fixture limit`,
      );
    }
  }
  const totalSeconds = matrix.reduce(
    (sum, run) => sum + run.durationSeconds,
    0,
  );
  if (
    now.getTime() + totalSeconds * 1000 >
    Date.parse(approval.window.endsAt)
  ) {
    throw new Error('approval window is too short for the execution matrix');
  }
  return matrix;
}
