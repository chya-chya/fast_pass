import { buildRpsVerdict } from './rps.js';

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
    },
    capacityStages,
    rpsStages,
    rpsLoad,
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
