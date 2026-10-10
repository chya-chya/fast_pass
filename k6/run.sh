#!/usr/bin/env bash

set -Eeuo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd "${script_dir}/.." && pwd -P)"
cd "${repository_root}"

if [[ $# -gt 1 ]] || [[ $# -eq 1 && "$1" != "--dry-run" ]]; then
  echo 'usage: k6/run.sh [--dry-run]' >&2
  exit 64
fi

if [[ $# -eq 1 ]]; then
  exec node k6/tools/config-cli.mjs --dry-run
fi

node k6/tools/config-cli.mjs --validate
scenario_script="$(node k6/tools/config-cli.mjs --script)"

result_dir="k6/results/${RUN_ID}"
if ! mkdir "${result_dir}"; then
  echo 'runner rejected: result directory already exists or is unavailable' >&2
  exit 1
fi

artifact_open=0
interrupted=0

mark_unfinished() {
  local exit_status=$?
  if [[ ${artifact_open} -eq 1 ]]; then
    if [[ ${interrupted} -eq 1 ]]; then
      node k6/tools/artifact-state.mjs incomplete ABORTED INTERRUPTED >/dev/null 2>&1 || true
    else
      node k6/tools/artifact-state.mjs incomplete FAILED RUNNER_FAILED >/dev/null 2>&1 || true
    fi
  fi
  exit "${exit_status}"
}

mark_interrupted() {
  interrupted=1
  exit 130
}

trap mark_unfinished EXIT
trap mark_interrupted INT TERM HUP

node k6/tools/artifact-state.mjs init
artifact_open=1

if ! node k6/tools/check-bind-sources.mjs; then
  node k6/tools/artifact-state.mjs incomplete FAILED PREFLIGHT_REJECTED
  artifact_open=0
  exit 1
fi

if ! node k6/tools/preflight.mjs; then
  node k6/tools/artifact-state.mjs incomplete FAILED PREFLIGHT_REJECTED
  artifact_open=0
  exit 1
fi
node k6/tools/artifact-state.mjs preflight
node k6/tools/capture-app-metrics.mjs

watchdog_status=0
if [[ "${SCENARIO}" =~ ^(spike|soak)$ ]]; then
  set +e
  K6_NO_USAGE_REPORT=true k6 run "${scenario_script}" &
  k6_pid=$!
  node k6/tools/watchdog.mjs "${k6_pid}" &
  watchdog_pid=$!
  wait "${k6_pid}"
  k6_status=$?
  if kill -0 "${watchdog_pid}" >/dev/null 2>&1; then
    kill -TERM "${watchdog_pid}" >/dev/null 2>&1
  fi
  wait "${watchdog_pid}"
  watchdog_status=$?
  set -e
else
  set +e
  K6_NO_USAGE_REPORT=true k6 run "${scenario_script}"
  k6_status=$?
  set -e
fi

set +e
K6_EXIT_STATUS="${k6_status}" node k6/tools/audit.mjs
audit_status=$?
set -e

k6_effective_status=${k6_status}
if [[ ${k6_status} -eq 99 ]] &&
  { [[ "${SCENARIO}" == 'capacity-vu' ]] ||
    [[ "${SCENARIO}" == 'capacity-rps' && "${RPS_TEST_PROFILE:-explore}" =~ ^(explore|confirm-110)$ ]]; }; then
  k6_effective_status=0
fi

if [[ ${watchdog_status} -eq 2 ]]; then
  execution='ABORTED'
  reason='WATCHDOG_ABORTED'
  final_status=2
elif [[ ${watchdog_status} -ne 0 ]]; then
  execution='FAILED'
  reason='WATCHDOG_FAILED'
  final_status=${watchdog_status}
elif [[ ${k6_effective_status} -ne 0 ]]; then
  execution='FAILED'
  if [[ ${k6_status} -eq 99 ]]; then
    reason='K6_THRESHOLD_ABORTED'
  else
    reason='K6_FAILED'
  fi
  final_status=${k6_effective_status}
elif [[ ${audit_status} -ne 0 ]]; then
  execution='FAILED'
  reason='AUDIT_FAILED'
  final_status=${audit_status}
else
  execution='COMPLETED'
  reason='NONE'
  final_status=0
fi

if ! node k6/tools/artifact-state.mjs finalize "${execution}" "${reason}"; then
  node k6/tools/artifact-state.mjs incomplete FAILED ARTIFACT_VALIDATION_FAILED || true
  artifact_open=0
  exit 1
fi

if ! node k6/tools/artifact-state.mjs verify; then
  node k6/tools/artifact-state.mjs incomplete FAILED ARTIFACT_VALIDATION_FAILED || true
  artifact_open=0
  exit 1
fi

artifact_open=0
exit "${final_status}"
