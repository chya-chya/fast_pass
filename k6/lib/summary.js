import { buildRpsVerdict } from './rps.js';
import { buildLongRunVerdict } from './endurance.js';

const ALLOWED_METRICS = Object.freeze([
  'checks',
  'http_req_duration',
  'http_req_failed',
  'iterations',
  'vus_max',
  'accepted',
  'expected_conflict',
  'unexpected_error',
  'timeout',
  'unexpected_error_rate',
  'request_start_offset_ms',
  'rebooking_first_accepted',
  'rebooking_second_accepted',
  'reservation_requests',
  'accepted_duration_ms',
  'expected_conflict_duration_ms',
  'unexpected_error_duration_ms',
  'timeout_duration_ms',
  'capacity_stage_1_requests',
  'capacity_stage_2_requests',
  'capacity_stage_3_requests',
  'capacity_stage_4_requests',
  'dropped_iterations',
  'reservation_requests_started',
  'reservation_responses_completed',
  'rps_stage_1_requests_started',
  'rps_stage_2_requests_started',
  'rps_stage_3_requests_started',
  'rps_stage_4_requests_started',
  'rps_stage_1_responses_completed',
  'rps_stage_2_responses_completed',
  'rps_stage_3_responses_completed',
  'rps_stage_4_responses_completed',
  'load_requests_started',
  'load_responses_completed',
  'spike_baseline_requests_started',
  'spike_baseline_responses_completed',
  'spike_baseline_accepted_duration_ms',
  'spike_baseline_unexpected_error',
  'spike_baseline_timeout',
  'spike_peak_requests_started',
  'spike_peak_responses_completed',
  'spike_peak_accepted_duration_ms',
  'spike_peak_unexpected_error',
  'spike_peak_timeout',
  'spike_recovery_requests_started',
  'spike_recovery_responses_completed',
  'spike_recovery_accepted_duration_ms',
  'spike_recovery_unexpected_error',
  'spike_recovery_timeout',
  'soak_requests_started',
  'soak_responses_completed',
  'soak_accepted_duration_ms',
  'soak_unexpected_error',
  'soak_timeout',
  ...Array.from({ length: 6 }, (_, index) => [
    `soak_window_${index + 1}_requests_started`,
    `soak_window_${index + 1}_responses_completed`,
    `soak_window_${index + 1}_accepted_duration_ms`,
    `soak_window_${index + 1}_unexpected_error`,
    `soak_window_${index + 1}_timeout`,
  ]).flat(),
]);

function cleanMetric(metric) {
  if (!metric) return null;
  const values = {};
  for (const [key, value] of Object.entries(metric.values || {})) {
    if (typeof value === 'number' && Number.isFinite(value))
      values[key] = value;
  }
  const thresholds = {};
  for (const [key, value] of Object.entries(metric.thresholds || {})) {
    thresholds[key] = { ok: value && value.ok === true };
  }
  return { type: metric.type, contains: metric.contains, values, thresholds };
}

export function buildSummary(config, data) {
  const metrics = {};
  for (const name of ALLOWED_METRICS) {
    const metric = cleanMetric(data.metrics && data.metrics[name]);
    if (metric) metrics[name] = metric;
  }

  const thresholdFailures = [];
  for (const [name, metric] of Object.entries(metrics)) {
    for (const [threshold, result] of Object.entries(metric.thresholds)) {
      if (!result.ok) thresholdFailures.push({ metric: name, threshold });
    }
  }

  const capacityStages =
    config.scenario === 'capacity-vu'
      ? config.capacityTargets.map((target, index) => {
          const requestCount = Number(
            metrics[`capacity_stage_${index + 1}_requests`]?.values?.count || 0,
          );
          const durationMs =
            config.capacityRampDurationMs +
            config.capacityStageHoldMs[index] +
            (index === config.capacityTargets.length - 1
              ? config.capacityRampDurationMs
              : 0);
          return {
            stage: index + 1,
            targetVus: target,
            rampDuration: config.capacityRampDuration,
            holdDuration: config.capacityStageHolds[index],
            measurementWindowMs: durationMs,
            requestCount,
            actualRps: requestCount / (durationMs / 1000),
          };
        })
      : null;
  const droppedIterations = Number(
    metrics.dropped_iterations?.values?.count || 0,
  );
  const startedRequests = Number(
    metrics.reservation_requests_started?.values?.count || 0,
  );
  const completedResponses = Number(
    metrics.reservation_responses_completed?.values?.count || 0,
  );
  const loadDurationSeconds = config.rpsLoadDurationMs
    ? config.rpsLoadDurationMs / 1000
    : 0;
  const rpsStages =
    config.scenario === 'capacity-rps'
      ? config.rpsTestProfile === 'explore'
        ? config.rpsTargets.map((target, index) => {
            const started = Number(
              metrics[`rps_stage_${index + 1}_requests_started`]?.values
                ?.count || 0,
            );
            const completed = Number(
              metrics[`rps_stage_${index + 1}_responses_completed`]?.values
                ?.count || 0,
            );
            const durationMs =
              config.rpsRampDurationMs +
              config.rpsStageHoldMs[index] +
              (index === config.rpsTargets.length - 1
                ? config.rpsRampDurationMs
                : 0);
            return {
              stage: index + 1,
              targetOfferedRps: target,
              rampDuration: config.rpsRampDuration,
              holdDuration: config.rpsStageHolds[index],
              measurementWindowMs: durationMs,
              startedRequests: started,
              completedResponses: completed,
              startedReservationRps: started / (durationMs / 1000),
              completedResponseRps: completed / (durationMs / 1000),
            };
          })
        : [
            {
              stage: 1,
              targetOfferedRps: config.rpsRate,
              rampDuration: null,
              holdDuration: config.rpsConfirmationDuration,
              measurementWindowMs: config.rpsLoadDurationMs,
              startedRequests,
              completedResponses,
              startedReservationRps: startedRequests / loadDurationSeconds,
              completedResponseRps: completedResponses / loadDurationSeconds,
            },
          ]
      : null;
  const rpsLoad =
    config.scenario === 'capacity-rps'
      ? {
          timeUnit: config.rpsTimeUnit,
          targetOfferedRps:
            config.rpsTestProfile === 'explore'
              ? config.rpsTargets
              : config.rpsRate,
          offeredIterations: startedRequests + droppedIterations,
          startedReservationRequests: startedRequests,
          completedResponses,
          droppedIterations,
          offeredRps:
            (startedRequests + droppedIterations) / loadDurationSeconds,
          startedReservationRps: startedRequests / loadDurationSeconds,
          completedResponseRps: completedResponses / loadDurationSeconds,
          serverEnqueued: null,
          serverEnqueueRps: null,
          serverEnqueueSource: 'server-metrics.json',
        }
      : null;
  const longRunScenario = ['spike', 'soak'].includes(config.scenario);
  const loadStartedRequests = Number(
    metrics.load_requests_started?.values?.count || 0,
  );
  const loadCompletedResponses = Number(
    metrics.load_responses_completed?.values?.count || 0,
  );
  const longRunPhaseNames =
    config.scenario === 'spike'
      ? ['baseline', 'peak', 'recovery']
      : config.scenario === 'soak'
        ? ['soak']
        : [];
  const longRunPhases = longRunScenario
    ? longRunPhaseNames.map((phase) => {
        const prefix = config.scenario === 'soak' ? 'soak' : `spike_${phase}`;
        const started = Number(
          metrics[`${prefix}_requests_started`]?.values?.count || 0,
        );
        const completed = Number(
          metrics[`${prefix}_responses_completed`]?.values?.count || 0,
        );
        const durationMs =
          config.scenario === 'soak'
            ? config.soakDurationMs
            : phase === 'baseline'
              ? config.spikeBaselineDurationMs
              : phase === 'peak'
                ? config.spikePeakDurationMs
                : config.spikeRecoveryDurationMs;
        const targetRps =
          config.scenario === 'soak' || phase === 'peak'
            ? config.scenario === 'soak'
              ? config.soakRps
              : config.spikePeakRps
            : config.spikeBaselineRps;
        return {
          phase,
          targetOfferedRps: targetRps,
          durationMs,
          startedRequests: started,
          completedResponses: completed,
          startedReservationRps: started / (durationMs / 1000),
          completedResponseRps: completed / (durationMs / 1000),
          acceptedLatency:
            metrics[`${prefix}_accepted_duration_ms`]?.values || {},
          unexpectedErrors: Number(
            metrics[`${prefix}_unexpected_error`]?.values?.count || 0,
          ),
          timeouts: Number(metrics[`${prefix}_timeout`]?.values?.count || 0),
        };
      })
    : null;
  const longRunLoad = longRunScenario
    ? {
        timeUnit: config.loadTimeUnit,
        offeredIterations: loadStartedRequests + droppedIterations,
        startedReservationRequests: loadStartedRequests,
        completedResponses: loadCompletedResponses,
        droppedIterations,
        offeredRps:
          (loadStartedRequests + droppedIterations) /
          (config.loadDurationMs / 1000),
        startedReservationRps:
          loadStartedRequests / (config.loadDurationMs / 1000),
        completedResponseRps:
          loadCompletedResponses / (config.loadDurationMs / 1000),
        serverEnqueued: null,
        serverEnqueueRps: null,
        serverEnqueueSource: 'server-metrics.json',
      }
    : null;
  const soakWindows =
    config.scenario === 'soak'
      ? Array.from({ length: 6 }, (_, index) => {
          const prefix = `soak_window_${index + 1}`;
          return {
            window: index + 1,
            startedAtMs: Math.floor((config.soakDurationMs * index) / 6),
            endedAtMs: Math.floor((config.soakDurationMs * (index + 1)) / 6),
            startedRequests: Number(
              metrics[`${prefix}_requests_started`]?.values?.count || 0,
            ),
            completedResponses: Number(
              metrics[`${prefix}_responses_completed`]?.values?.count || 0,
            ),
            acceptedLatency:
              metrics[`${prefix}_accepted_duration_ms`]?.values || {},
            unexpectedErrors: Number(
              metrics[`${prefix}_unexpected_error`]?.values?.count || 0,
            ),
            timeouts: Number(metrics[`${prefix}_timeout`]?.values?.count || 0),
          };
        })
      : null;

  return {
    schemaVersion: 1,
    runId: config.runId,
    scenario: config.scenario,
    dataset: {
      cacheProfile: config.cacheProfile,
      vus: config.vus,
      iterationsPerVu: config.iterationsPerVu,
      totalRequests: config.totalRequests,
      seatCount: config.seatCount,
      expectedAccepted: config.expectedAccepted,
      expectedConflicts: config.expectedConflicts,
      requestsPerSeat: config.requestsPerSeat,
      capacityProfile: config.capacityProfile,
      userBehavior: config.capacityUserBehavior,
      thinkTime: config.capacityThinkTime,
      requestBudget: config.capacityRequestBudget,
      rpsTestProfile: config.rpsTestProfile,
      rpsDataProfile:
        config.scenario === 'capacity-rps' ? config.capacityProfile : null,
      rpsRequestBudget: config.rpsRequestBudget,
      preAllocatedVUs: config.rpsPreAllocatedVus,
      maxVUs: config.rpsMaxVus,
      loadTestReduced: config.loadTestReduced,
      loadRequestBudget: config.loadRequestBudget,
      fixtureCapacityPlan: config.fixtureCapacityPlan,
      authenticationTtlSeconds: config.loadAccessTokenTtlSeconds,
    },
    capacityStages,
    rpsStages,
    rpsLoad,
    longRunPhases,
    longRunLoad,
    soakWindows,
    generatedAt: new Date().toISOString(),
    thresholdPassed: thresholdFailures.length === 0,
    thresholdFailures,
    verdict:
      config.scenario === 'capacity-vu'
        ? {
            kind: 'exploratory',
            status: 'NOT_APPLICABLE',
            sloThresholdsPassed: thresholdFailures.length === 0,
          }
        : config.scenario === 'capacity-rps'
          ? buildRpsVerdict(config, thresholdFailures, droppedIterations)
          : longRunScenario
            ? buildLongRunVerdict(config, thresholdFailures, droppedIterations)
            : {
                kind: 'correctness',
                status: thresholdFailures.length === 0 ? 'PASS' : 'FAIL',
              },
    metrics,
  };
}

export function createHandleSummary(config) {
  return (data) => {
    const summary = buildSummary(config, data);
    return {
      [config.summaryTempPath]: `${JSON.stringify(summary, null, 2)}\n`,
      stdout: `${config.scenario} summary: thresholdPassed=${summary.thresholdPassed}\n`,
    };
  };
}
