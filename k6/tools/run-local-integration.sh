#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "${script_dir}/../.." && pwd -P)"
cd "${repository_root}"

scenario="${1:-smoke}"
if [[ $# -gt 1 ]] || [[ ! "${scenario}" =~ ^(smoke|consistency-one-seat|consistency-inventory|rebooking|capacity-vu|capacity-rps|spike|soak)$ ]]; then
  echo 'usage: k6/tools/run-local-integration.sh [smoke|consistency-one-seat|consistency-inventory|rebooking|capacity-vu|capacity-rps|spike|soak]' >&2
  exit 64
fi

for required_command in docker node npm openssl ps rg shasum; do
  if ! command -v "${required_command}" >/dev/null 2>&1; then
    echo "integration rejected: ${required_command} is unavailable" >&2
    exit 1
  fi
done

temporary_directory="$(mktemp -d /private/tmp/fastpass-k6-integration.XXXXXX)"
application_log="${temporary_directory}/application.log"
application_pid=''
compose_started=0

allocate_port() {
  node -e "const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{process.stdout.write(String(server.address().port));server.close();});"
}

cleanup() {
  local exit_status="$1"
  trap - EXIT INT TERM HUP
  if [[ -n "${application_pid}" ]] && kill -0 "${application_pid}" >/dev/null 2>&1; then
    kill "${application_pid}" >/dev/null 2>&1 || true
    wait "${application_pid}" >/dev/null 2>&1 || true
  fi
  if [[ ${compose_started} -eq 1 ]]; then
    docker compose -p "${K6_COMPOSE_PROJECT}" -f docker-compose.k6.yaml down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  if [[ "${temporary_directory}" == /private/tmp/fastpass-k6-integration.* ]]; then
    rm -f "${application_log}"
    rmdir "${temporary_directory}" 2>/dev/null || true
  fi
  exit "${exit_status}"
}

trap 'cleanup $?' EXIT
trap 'exit 130' INT TERM HUP

run_suffix="$(date -u +%Y%m%d%H%M%S)-$$"
export TEST_ENVIRONMENT='local-disposable'
export TEST_ENV_ID="k6int${run_suffix//-/}"
export TEST_DATABASE_NAME="fast_pass_k6_${TEST_ENV_ID}"
export TEST_REDIS_ID="redis-${TEST_ENV_ID}"
export REDIS_KEY_PREFIX="k6:${TEST_ENV_ID}:"
export ALLOW_TEST_DATA_MUTATION='true'
export EXPECTED_APP_ID='fast_pass'
export EXPECTED_MIGRATION_ID="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | LC_ALL=C sort | tail -1)"
export EXPECTED_DB_TLS_MODE='disable'
export EXPECTED_REDIS_TLS_MODE='disable'
export EXPECTED_TRACING_ENABLED='false'
export EXPECTED_OTEL_TRACE_SAMPLE_RATIO='0.1'
export EXPECTED_OTEL_MIN_SPAN_DURATION_MS='0'
export TEST_PREFLIGHT_TOKEN="$(openssl rand -hex 32)"
export K6_DB_PASSWORD="$(openssl rand -hex 24)"
export K6_POSTGRES_PORT="$(allocate_port)"
export K6_REDIS_PORT="$(allocate_port)"
export K6_APPLICATION_PORT="$(allocate_port)"
export K6_COMPOSE_PROJECT="fastpass-k6-${run_suffix}"
export SCENARIO="${scenario}"
export RUN_ID="local-${scenario}-${run_suffix}"
export BASE_URL="http://127.0.0.1:${K6_APPLICATION_PORT}"
export RPS='1'
export DURATION='5s'
export CACHE_PROFILE="${CACHE_PROFILE:-warm}"
case "${scenario}" in
  smoke)
    export VU='1'
    export USER_COUNT='1'
    export SEAT_COUNT='5'
    ;;
  consistency-one-seat)
    export VU='4'
    export USER_COUNT='4'
    export SEAT_COUNT='1'
    ;;
  consistency-inventory)
    export VU='4'
    export USER_COUNT='4'
    export SEAT_COUNT='2'
    ;;
  rebooking)
    export VU='1'
    export USER_COUNT='1'
    export SEAT_COUNT='1'
    ;;
  capacity-vu)
    unset RPS
    export CAPACITY_PROFILE="${CAPACITY_PROFILE:-unique-seat}"
    export CAPACITY_VU_STAGES='1,2,3,4'
    export CAPACITY_RAMP_DURATION='1s'
    export CAPACITY_STAGE_HOLD_1='2s'
    export CAPACITY_STAGE_HOLD_2='2s'
    export CAPACITY_STAGE_HOLD_3='2s'
    export CAPACITY_STAGE_HOLD_4='2s'
    export CAPACITY_THINK_TIME='1s'
    export CAPACITY_USER_BEHAVIOR='reserve-then-think'
    export CAPACITY_REQUEST_BUDGET='64'
    export USER_COUNT='4'
    if [[ "${CAPACITY_PROFILE}" == 'unique-seat' ]]; then
      export SEAT_COUNT='64'
    else
      export SEAT_COUNT='1'
    fi
    ;;
  capacity-rps)
    unset RPS
    unset DURATION
    export RPS_TEST_PROFILE="${RPS_TEST_PROFILE:-explore}"
    export CAPACITY_PROFILE="${CAPACITY_PROFILE:-unique-seat}"
    export RPS_TIME_UNIT='1s'
    export RPS_STAGES='1,2,3,4'
    export RPS_RAMP_DURATION='1s'
    export RPS_STAGE_HOLD_1='1s'
    export RPS_STAGE_HOLD_2='1s'
    export RPS_STAGE_HOLD_3='1s'
    export RPS_STAGE_HOLD_4='1s'
    export RPS_RATE='4'
    export RPS_DURATION='5s'
    export RPS_PRE_ALLOCATED_VUS='4'
    export RPS_MAX_VUS='10'
    export RPS_REQUEST_BUDGET='64'
    export USER_COUNT='10'
    if [[ "${CAPACITY_PROFILE}" == 'unique-seat' ]]; then
      export SEAT_COUNT='64'
    else
      export SEAT_COUNT='1'
    fi
    ;;
  spike)
    unset RPS
    unset DURATION
    export LOAD_TEST_REDUCED='true'
    export LOAD_TIME_UNIT='1s'
    export SPIKE_BASELINE_RPS='2'
    export SPIKE_PEAK_RPS='4'
    export SPIKE_BASELINE_DURATION='3s'
    export SPIKE_PEAK_DURATION='2s'
    export SPIKE_RECOVERY_DURATION='4s'
    export LOAD_PRE_ALLOCATED_VUS='4'
    export LOAD_MAX_VUS='10'
    export LOAD_REQUEST_BUDGET='64'
    export FIXTURE_SEED_MODE='api-array'
    export USER_COUNT='10'
    export SEAT_COUNT='64'
    ;;
  soak)
    unset RPS
    unset DURATION
    export LOAD_TEST_REDUCED='true'
    export LOAD_TIME_UNIT='1s'
    export CONFIRMED_SUSTAINABLE_RPS='5'
    export CONFIRMED_CAPACITY_RUN_ID='local-confirmation-evidence'
    export SOAK_RATE_PERCENT='60'
    export SOAK_DURATION='8s'
    export LOAD_PRE_ALLOCATED_VUS='3'
    export LOAD_MAX_VUS='10'
    export LOAD_REQUEST_BUDGET='64'
    export FIXTURE_SEED_MODE='api-array'
    export USER_COUNT='10'
    export SEAT_COUNT='64'
    ;;
esac

if [[ "${scenario}" =~ ^(spike|soak)$ ]]; then
  export FIXTURE_SAFETY_PERCENT='110'
  export LOAD_SETUP_ALLOWANCE='1m'
  export LOAD_DRAIN_ALLOWANCE='1m'
  export LOAD_AUDIT_ALLOWANCE='1m'
  export LOAD_TOKEN_SAFETY='1m'
  export LOAD_ACCESS_TOKEN_TTL='15m'
  export K6_ACCESS_TOKEN_TTL_SECONDS='900'
  export WATCHDOG_POLL_INTERVAL_MS='500'
  export WATCHDOG_CONSECUTIVE_VIOLATIONS='3'
  export WATCHDOG_MAX_QUEUE_DEPTH='1000'
fi

npm run build >/dev/null
export EXPECTED_BUILD_SHA="$(find dist/src -type f -print | LC_ALL=C sort | xargs shasum -a 1 | shasum -a 1 | awk '{print $1}')"

compose_started=1
docker compose -p "${K6_COMPOSE_PROJECT}" -f docker-compose.k6.yaml up -d --wait --wait-timeout 60 --pull never

database_url="postgresql://k6:${K6_DB_PASSWORD}@127.0.0.1:${K6_POSTGRES_PORT}/${TEST_DATABASE_NAME}"
export AUDIT_DATABASE_URL="${database_url}"
export AUDIT_REDIS_HOST='127.0.0.1'
export AUDIT_REDIS_PORT="${K6_REDIS_PORT}"
DATABASE_URL="${database_url}" DB_SSL_MODE=disable ./node_modules/.bin/prisma migrate deploy >/dev/null

if [[ "${RUN_REBOOKING_INTEGRATION:-false}" == 'true' ]]; then
  DATABASE_URL="${database_url}" \
  DB_SSL_MODE=disable \
  REDIS_HOST=127.0.0.1 \
  REDIS_PORT="${K6_REDIS_PORT}" \
  RUN_REBOOKING_INTEGRATION=true \
  npm test -- --runInBand src/reservation/reservation.rebooking.integration.spec.ts
  exit 0
fi

if [[ "${RUN_QUEUE_DURABILITY_INTEGRATION:-false}" == 'true' ]]; then
  DATABASE_URL="${database_url}" \
  DB_SSL_MODE=disable \
  REDIS_HOST=127.0.0.1 \
  REDIS_PORT="${K6_REDIS_PORT}" \
  RUN_QUEUE_DURABILITY_INTEGRATION=true \
  npm test -- --runInBand src/reservation/reservation.queue-durability.integration.spec.ts
  exit 0
fi

redis_marker="{\"testEnvId\":\"${TEST_ENV_ID}\",\"redisId\":\"${TEST_REDIS_ID}\",\"keyPrefix\":\"${REDIS_KEY_PREFIX}\"}"
docker compose -p "${K6_COMPOSE_PROJECT}" -f docker-compose.k6.yaml exec -T redis redis-cli SET "${REDIS_KEY_PREFIX}environment" "${redis_marker}" >/dev/null

jwt_secret="$(openssl rand -hex 32)"
env \
  NODE_ENV=test \
  PORT="${K6_APPLICATION_PORT}" \
  DATABASE_URL="${database_url}" \
  DB_SSL_MODE=disable \
  REDIS_HOST=127.0.0.1 \
  REDIS_PORT="${K6_REDIS_PORT}" \
  REDIS_CLUSTER_MODE=false \
  REDIS_USE_TLS=false \
  RESERVATION_RECLAIM_IDLE_MS=1000 \
  RESERVATION_MAX_DELIVERIES=3 \
  RESERVATION_METRICS_REFRESH_MS=1000 \
  RESERVATION_METRICS_PEL_SCAN_LIMIT=10000 \
  ENABLE_TEST_PREFLIGHT=true \
  APP_ID="${EXPECTED_APP_ID}" \
  APP_BUILD_SHA="${EXPECTED_BUILD_SHA}" \
  TEST_ENVIRONMENT="${TEST_ENVIRONMENT}" \
  TEST_ENV_ID="${TEST_ENV_ID}" \
  TEST_DATABASE_NAME="${TEST_DATABASE_NAME}" \
  TEST_REDIS_ID="${TEST_REDIS_ID}" \
  REDIS_KEY_PREFIX="${REDIS_KEY_PREFIX}" \
  TEST_PREFLIGHT_TOKEN="${TEST_PREFLIGHT_TOKEN}" \
  ALLOW_TEST_DATA_MUTATION="${ALLOW_TEST_DATA_MUTATION}" \
  K6_ACCESS_TOKEN_TTL_SECONDS="${K6_ACCESS_TOKEN_TTL_SECONDS:-}" \
  JWT_SECRET="${jwt_secret}" \
  ENABLE_TRACING=false \
  OTEL_TRACE_SAMPLE_RATIO="${EXPECTED_OTEL_TRACE_SAMPLE_RATIO}" \
  OTEL_MIN_SPAN_DURATION_MS="${EXPECTED_OTEL_MIN_SPAN_DURATION_MS}" \
  npm run start:prod >"${application_log}" 2>&1 &
application_pid=$!

preflight_ready=0
for _ in {1..60}; do
  if node k6/tools/preflight.mjs >/dev/null 2>&1; then
    preflight_ready=1
    break
  fi
  if ! kill -0 "${application_pid}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if [[ ${preflight_ready} -ne 1 ]]; then
  echo 'integration rejected: application preflight did not become ready' >&2
  exit 1
fi

k6/run.sh

(
  cd "k6/results/${RUN_ID}"
  shasum -a 256 -c checksums.sha256 >/dev/null
)
node -e "const fs=require('node:fs');const root='k6/results/'+process.env.RUN_ID;const required=['metadata.json','fixture-manifest.json','summary.json','consistency-audit.json','server-metrics.json','report.md','checksums.sha256'];for(const name of required){if(!fs.statSync(root+'/'+name).isFile())process.exit(1)}const metadata=JSON.parse(fs.readFileSync(root+'/metadata.json','utf8'));const summary=JSON.parse(fs.readFileSync(root+'/summary.json','utf8'));const audit=JSON.parse(fs.readFileSync(root+'/consistency-audit.json','utf8'));const metrics=JSON.parse(fs.readFileSync(root+'/server-metrics.json','utf8'));const capacityVu=process.env.SCENARIO==='capacity-vu';const capacityRps=process.env.SCENARIO==='capacity-rps';const longRun=['spike','soak'].includes(process.env.SCENARIO);const audited=process.env.SCENARIO!=='smoke'&&!capacityVu&&!capacityRps&&!longRun;const stableRps=capacityRps&&['confirm-50','confirm-75','confirm-100'].includes(process.env.RPS_TEST_PROFILE);const thresholdRequired=!capacityVu&&(!capacityRps||stableRps);const longKind=process.env.SCENARIO==='spike'?'recovery-preflight':'endurance-preflight';if(metadata.execution!=='COMPLETED'||metadata.artifactSet!=='FINALIZED'||metadata.preflight!=='VERIFIED'||metadata.audit?.pass!==true||summary.scenario!==process.env.SCENARIO||(thresholdRequired&&summary.thresholdPassed!==true)||audit.consistency?.pass!==true||audit.counters?.workerInFlight!==0||metrics.schemaVersion!==2||metrics.app?.status!=='available'||metrics.app?.valid!==true||(audited&&(!audit.requestAudit||audit.requestAudit.actualAccepted!==summary.dataset.expectedAccepted||audit.requestAudit.actualConflicts!==summary.dataset.expectedConflicts))||(capacityVu&&(!audit.requestAudit||metadata.verdict?.kind!=='exploratory'||metadata.verdict?.status!=='NOT_APPLICABLE'||summary.dataset.capacityProfile!==process.env.CAPACITY_PROFILE))||(capacityRps&&(!audit.requestAudit||summary.dataset.rpsTestProfile!==process.env.RPS_TEST_PROFILE||summary.dataset.rpsDataProfile!==process.env.CAPACITY_PROFILE||summary.rpsLoad?.timeUnit!=='1s'||summary.rpsLoad?.startedReservationRequests!==summary.rpsLoad?.completedResponses||metrics.load?.serverEnqueued!==summary.metrics.accepted?.values?.count||metadata.verdict?.kind!==(stableRps?'capacity-confirmation':process.env.RPS_TEST_PROFILE==='confirm-110'?'exploratory-overload':'exploratory')||(stableRps&&metadata.verdict?.status!=='PASS')))||(longRun&&(!audit.requestAudit||summary.longRunLoad?.timeUnit!=='1s'||summary.longRunLoad?.startedReservationRequests!==summary.longRunLoad?.completedResponses||metrics.load?.serverEnqueued!==summary.metrics.accepted?.values?.count||metrics.watchdog?.status!=='COMPLETED'||metrics.watchdog?.sampleCount<1||metadata.verdict?.kind!==longKind||metadata.verdict?.status!=='NOT_APPLICABLE'||metadata.verdict?.integrationChecksPassed!==true||audit.experimentVerdict?.integrationChecksPassed!==true||metrics.app?.summary?.histograms?.persistenceLatencySeconds?.p95UpperBound==null))||(process.env.SCENARIO==='rebooking'&&(!audit.rebooking||audit.rebooking.firstStatus!=='CANCELLED'||!['PENDING','CONFIRMED'].includes(audit.rebooking.secondStatus)||audit.rebooking.activeCount!==1))){process.exit(1)}"
node k6/tools/cleanup.mjs --dry-run >/dev/null
if rg -n -i 'bearer[[:space:]]|postgres(?:ql)?://|redis(?:s)?://|password|secret|token' "k6/results/${RUN_ID}" >/dev/null; then
  echo 'integration rejected: sensitive content found in artifacts' >&2
  exit 1
fi

echo "integration verified: ${RUN_ID}"
