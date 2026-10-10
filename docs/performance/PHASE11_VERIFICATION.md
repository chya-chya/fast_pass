# 11단계 Spike·Soak 검증 기록

## 판정

**`INTEGRATION_VERIFIED` — clean source의 일회성 로컬 앱·PostgreSQL·Redis에서 축소 Spike·Soak의 watchdog, queue drain, 6구간 Soak SLO와 ID 단위 사후 감사 완료**

원격 Spike·Soak는 실행하지 않았다. 아래 결과는 실행 경로와 안전장치의 통합 검증이며 실제 회복성·지속 가능 처리량 qualification이 아니다. 두 verdict가 `NOT_APPLICABLE`인 이유도 이 제한 때문이다.

## 구현 Profile

| 시나리오 | 기본 profile                               | 핵심 판정                                                                                                               |
| -------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Spike    | 300 RPS 2분 → 1,000 RPS 30초 → 300 RPS 3분 | peak/recovery p95·p99, recovery 오류·timeout, baseline 대비 recovery p95 비율, drop, queue drain, persistence와 ID 감사 |
| Soak     | 확인된 지속 가능 RPS의 65%, 최소 60분      | 6개 동일 구간 SLO, RSS·queue 추세, restart·eviction, drop, drain, persistence와 ID 감사                                 |

RPS, duration, VU pool, 안전 여유, fixture byte 추정치, 인증 TTL, watchdog polling·연속 위반 기준은 환경변수로 조정한다. 원격 대상은 11단계 runner가 계속 거부한다. 로컬 실제 실행은 `LOAD_TEST_REDUCED=true`, 20 RPS·1분·500 requests·100 max VU 이하, `api-array` fixture만 허용한다.

## Fixture와 인증 사전 계산

계산식은 `Σ(목표 RPS × 구간 초) × 고유 좌석 1 × 안전 여유`다. 기본 안전 여유 110%를 각 Spike 구간에 독립 적용해 경계 iteration의 반올림까지 서로 겹치지 않는 ID 영역을 확보한다.

| 기본 profile        |    scheduled / budget |   users / seats | 예상 DB 행 |       DB·저장 / Redis | seed·cleanup 예상 |
| ------------------- | --------------------: | --------------: | ---------: | --------------------: | ----------------: |
| Spike               |     120,000 / 132,000 | 1,000 / 132,000 |    265,002 |   64.5 MiB / 32.2 MiB |        각 약 27초 |
| Soak 325 RPS × 60분 | 1,170,000 / 1,287,000 | 325 / 1,287,000 |  2,574,327 | 628.4 MiB / 314.2 MiB |       각 약 258초 |

사용자·좌석·DB 행·DB/Redis/저장 byte가 승인 상한을 넘거나 seed·cleanup 처리량 값이 유효하지 않으면 preflight가 거부한다. `api-array`는 25,000좌석 이하로 제한했다. 대용량은 격리 환경 전용 chunk/bulk transaction, chunk checkpoint/checksum, 미완료 chunk 재개와 run ID 기반 exact cleanup 계약을 [LOAD_TEST_RUNBOOK.md](./LOAD_TEST_RUNBOOK.md)에 정의했으며 해당 provisioner 없이 원격 실행할 수 없다.

토큰 TTL은 `setup + load + drain + audit + safety` 합보다 길어야 한다. 기본 Spike 요구량은 약 47분 30초, 기본 Soak는 102분이고 설정 기본값은 2시간이다. 로컬 축소 실행은 앱과 preflight에 15분을 동일하게 적용했다. 테스트 TTL override는 비운영·preflight 활성·`local-disposable` 환경에서만 5분~24시간 범위를 허용하고 운영·공유 환경에서는 거부한다. 401은 예상 충돌이나 capacity 실패가 아닌 예상하지 않은 오류다.

## 자동 중단과 artifact

watchdog 기본값은 2초 polling과 연속 3회 위반이다. 앱 오류율, DB connection 비율, Redis eviction/조회 실패, event-loop lag, queue depth, process restart와 k6 발생기 CPU를 수집한다. k6 threshold는 예상하지 않은 오류와 dropped iteration을 중단한다. 로컬에 없는 ALB·PM2는 unavailable 사유를 명시하고, 원격에서는 adapter가 없으면 preflight를 통과할 수 없도록 Runbook 계약을 정했다.

watchdog 중단 사유는 k6 중단 전에 임시 artifact에 원자적으로 쓰고 최종 `server-metrics.json`과 `metadata.json`에 보존한다. 부하 종료 뒤 자동 감사가 queue/in-flight의 감소와 1초 안정 상태를 확인하며 30초 안에 drain되지 않으면 실패한다.

## clean-source 축소 통합 실행

| Run                                | source                 | 부하 경계                                             | latency·자원                                                                                              | drain·감사                                                   | verdict                                                         |
| ---------------------------------- | ---------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `local-spike-20261010063441-33516` | `45fb844`, dirty=false | offered/start/enqueue/completed `23/23/23/23`, drop 0 | baseline/peak/recovery p95 `45.49/26.39/21.83ms`, recovery ratio 0.48, persistence p95 0.25s, max queue 2 | 1,068ms, consistency/observability PASS, watchdog 22 samples | `recovery-preflight / NOT_APPLICABLE`, integration checks PASS  |
| `local-soak-20261010063524-34669`  | `a5a3034`, dirty=false | offered/start/enqueue/completed `25/25/25/25`, drop 0 | 6구간 p95 `13.04~19.40ms`, 오류·timeout 0, persistence p95 0.25s, max queue 1                             | 1,076ms, consistency/observability PASS, watchdog 21 samples | `endurance-preflight / NOT_APPLICABLE`, integration checks PASS |

두 Run 모두 reservation request manifest와 accepted → processed → persisted ID 집합이 정확히 일치했고 pending/processing/retry/DLQ와 worker in-flight가 최종 0이었다. Redis eviction, process restart와 watchdog 입력 누락도 0이었다. checksum 및 artifact 비밀정보 검사를 통과했다.

- [최종 Spike artifact](../../k6/results/local-spike-20261010063441-33516/)
- [최종 Soak artifact](../../k6/results/local-soak-20261010063524-34669/)

## 진단 이력

`local-spike-20261010040009-61892`는 Spike 구간 경계에서 마지막 iteration과 다음 구간의 첫 iteration ID가 겹치는 결함을 발견한 실패 Run이다. 구간별 안전 여유를 독립 적용하고 감사가 비연속 request ID 집합을 재구성하도록 수정했다. `local-spike-20261010040154-63788`과 `local-soak-20261010040231-64763`은 그 뒤 기능 연결을 확인한 dirty 진단 Run이며 최종 Gate 근거로 사용하지 않는다.

## 검증 명령과 결과

- `git diff --check`: 통과
- `npm run build`: 통과
- `node --test k6/tests/*.test.js`: 67/67 통과
- `npm test -- --runInBand src/auth/access-token-ttl.spec.ts src/health/test-run.controller.spec.ts`: 11/11 통과
- 변경 TypeScript ESLint: 통과
- `k6 inspect --execution-requirements k6/scenarios/spike.js`: 기본 300→1,000→300 RPS와 2m/30s/3m 확인
- `k6 inspect --execution-requirements k6/scenarios/soak.js`: 기본 325 RPS, 60m, 6개 window threshold 확인
- Runbook 사전 승인·중단·사후 감사·cleanup 검토: 완료
- 두 최종 artifact checksum 검증: 통과

## 남은 제한

- 기본 원격 profile은 실행하지 않았으며 `REMOTE_VERIFIED`가 아니다.
- 로컬 축소 실행의 latency, RSS와 처리량은 운영 용량 근거가 아니다.
- 원격 실행 전 승인 manifest 검증, ALB·PM2 watchdog adapter, chunk/bulk provisioner와 외부 시계열 보존을 후속 단계에서 연결해야 한다.
