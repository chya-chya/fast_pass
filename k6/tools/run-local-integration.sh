#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "${script_dir}/../.." && pwd -P)"
cd "${repository_root}"

scenario="${1:-smoke}"
if [[ $# -gt 1 ]] || [[ ! "${scenario}" =~ ^(smoke|consistency-one-seat|consistency-inventory|rebooking)$ ]]; then
  echo 'usage: k6/tools/run-local-integration.sh [smoke|consistency-one-seat|consistency-inventory|rebooking]' >&2
  exit 64
fi

for required_command in docker node npm openssl rg shasum; do
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
esac

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
  JWT_SECRET="${jwt_secret}" \
  ENABLE_TRACING=false \
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
node -e "const fs=require('node:fs');const root='k6/results/'+process.env.RUN_ID;const required=['metadata.json','fixture-manifest.json','summary.json','consistency-audit.json','server-metrics.json','report.md','checksums.sha256'];for(const name of required){if(!fs.statSync(root+'/'+name).isFile())process.exit(1)}const metadata=JSON.parse(fs.readFileSync(root+'/metadata.json','utf8'));const summary=JSON.parse(fs.readFileSync(root+'/summary.json','utf8'));const audit=JSON.parse(fs.readFileSync(root+'/consistency-audit.json','utf8'));const audited=process.env.SCENARIO!=='smoke';if(metadata.execution!=='COMPLETED'||metadata.artifactSet!=='FINALIZED'||metadata.preflight!=='VERIFIED'||metadata.audit?.pass!==true||summary.scenario!==process.env.SCENARIO||summary.thresholdPassed!==true||audit.consistency?.pass!==true||audit.counters?.workerInFlight!==0||(audited&&(!audit.requestAudit||audit.requestAudit.actualAccepted!==summary.dataset.expectedAccepted||audit.requestAudit.actualConflicts!==summary.dataset.expectedConflicts))||(process.env.SCENARIO==='rebooking'&&(!audit.rebooking||audit.rebooking.firstStatus!=='CANCELLED'||!['PENDING','CONFIRMED'].includes(audit.rebooking.secondStatus)||audit.rebooking.activeCount!==1))){process.exit(1)}"
node k6/tools/cleanup.mjs --dry-run >/dev/null
if rg -n -i 'bearer[[:space:]]|postgres(?:ql)?://|redis(?:s)?://|password|secret|token' "k6/results/${RUN_ID}" >/dev/null; then
  echo 'integration rejected: sensitive content found in artifacts' >&2
  exit 1
fi

echo "integration verified: ${RUN_ID}"
