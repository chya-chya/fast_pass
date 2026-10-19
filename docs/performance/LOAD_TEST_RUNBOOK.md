# Spike·Soak 부하 테스트 Runbook

## 범위와 실행 Gate

이 문서는 FastPass의 Spike 회복성과 Soak 장시간 안정성을 검증할 때 사용하는 사전 승인, 데이터 준비, 자동 중단, 사후 감사와 cleanup 절차를 정의한다. 11단계 runner는 원격 실행을 의도적으로 거부하며, `k6/tools/run-local-integration.sh spike|soak`의 축소형 일회성 로컬 실행만 허용한다. 축소 실행의 verdict는 `NOT_APPLICABLE`이고, watchdog·drain·ID 감사 연결을 검증할 뿐 원격 성능을 입증하지 않는다.

원격 실행 기능을 여는 후속 단계에서는 실행 전에 아래 항목이 하나라도 비어 있으면 중단한다.

| 승인 항목 | 필수 기록                                                               |
| --------- | ----------------------------------------------------------------------- |
| 대상      | 일회성 격리 환경 ID, 앱 build SHA, 전용 DB 이름, 전용 Redis ID·prefix   |
| 부하      | 시나리오, 최대 RPS, VU 상한, duration, fixture 상한                     |
| 시간      | 시작·종료·drain·감사·cleanup을 포함한 허용 시간대와 timezone            |
| 책임      | 실행 승인자, 앱·DB·Redis·ALB 담당자, 비용 책임자                        |
| 비용      | 예상 앱/DB/Redis/ALB/관측 저장 비용과 한도                              |
| 선행 근거 | Soak의 `CONFIRMED_CAPACITY_RUN_ID`, 오류 계약·queue 내구성·ID 감사 Gate |
| 중단 경로 | k6 PID 제어 권한, watchdog 입력 접근, 담당자 연락 경로                  |

운영 환경, 공유 DB/Redis, 지속 볼륨 또는 소유권이 불분명한 환경에는 실행하지 않는다. 승인 값은 토큰·비밀번호·접속 문자열을 포함하지 않는 별도 manifest로 보존한다.

## Profile

### Spike

- 기본 흐름: `300 RPS × 2m` → `1,000 RPS × 30s` → `300 RPS × 3m`.
- 환경변수: `SPIKE_BASELINE_RPS`, `SPIKE_PEAK_RPS`, `SPIKE_BASELINE_DURATION`, `SPIKE_PEAK_DURATION`, `SPIKE_RECOVERY_DURATION`.
- `LOAD_TIME_UNIT`은 `1s`만 허용한다. `LOAD_PRE_ALLOCATED_VUS`와 `LOAD_MAX_VUS`가 발생기 동시성 상한을 정한다.
- 구간별 global iteration 영역은 안전 여유를 포함해 분리한다. 구간 경계에서 한 iteration이 추가 예약돼도 request ID와 좌석이 다음 구간과 겹치지 않는다.

Spike 결과에는 baseline·peak·recovery의 offered/start/completed 수, accepted p95/p99, 오류·timeout, dropped iteration, queue 최대 길이, post-load drain, DB persistence p95를 포함한다.

### Soak

- 기본 흐름: `CONFIRMED_SUSTAINABLE_RPS × SOAK_RATE_PERCENT(기본 65%)`를 최소 `60m` 유지한다.
- `SOAK_RATE_PERCENT`는 60~70만 허용하며 산출 RPS는 올림한다.
- 환경변수: `CONFIRMED_SUSTAINABLE_RPS`, `CONFIRMED_CAPACITY_RUN_ID`, `SOAK_RATE_PERCENT`, `SOAK_DURATION`.
- 실행 시간은 6개 동일 구간으로 나눈다. 각 구간별 accepted p95/p99, 시작·완료 수, 오류와 timeout을 별도로 기록한다.
- 60분 미만은 `LOAD_TEST_REDUCED=true`인 로컬 연결 검증에서만 허용한다.

Soak 결과에는 위 6개 구간과 전체 offered/start/completed 수, dropped iteration, RSS·queue 증가 추세, restart, queue 최대 길이, drain, DB persistence p95와 최종 ID 감사를 포함한다.

## Fixture 사전 계산과 상한

성공 경로의 고유 좌석 수는 다음 식으로 계산한다.

```text
scheduled requests = Σ(목표 RPS × 구간 실행 초)
required request budget = ceil(scheduled requests × FIXTURE_SAFETY_PERCENT / 100)
required seats = required request budget × 요청당 고유 좌석 수(현재 1)
expected DB rows = users + seats + reservation rows + event/performance 2행
```

기본 `FIXTURE_SAFETY_PERCENT`는 110이다. preflight는 사용자·좌석·예상 예약 및 DB 행, DB/Redis/저장 용량, seed/cleanup 예상 시간을 metadata에 기록하고 다음 상한 중 하나라도 넘으면 실행을 거부한다.

| 항목            | 기본 상한 |
| --------------- | --------: |
| 사용자          |    10,000 |
| 좌석            | 2,000,000 |
| DB 행           | 5,000,000 |
| DB 추정 용량    |     2 GiB |
| Redis 추정 용량 |     1 GiB |
| 저장 추정 용량  |     2 GiB |

추정 단가는 요청당 DB/저장 512 bytes, Redis 256 bytes이며 실제 환경 측정값으로 보정한다. 기본 profile 계산은 다음과 같다.

| Profile            | scheduled / 110% budget |   users / seats | 예상 DB 행 |       DB·저장 / Redis | seed·cleanup 예상 |
| ------------------ | ----------------------: | --------------: | ---------: | --------------------: | ----------------: |
| Spike              |       120,000 / 132,000 | 1,000 / 132,000 |    265,002 |   64.5 MiB / 32.2 MiB |        각 약 27초 |
| Soak 325 RPS × 60m |   1,170,000 / 1,287,000 | 325 / 1,287,000 |  2,574,327 | 628.4 MiB / 314.2 MiB |       각 약 258초 |

`LOAD_REQUEST_BUDGET`, `USER_COUNT`, `SEAT_COUNT`, `FIXTURE_MAX_*`, 요청당 byte 추정치와 초당 seed/cleanup 행 수는 승인 manifest 값과 일치해야 한다. `SEAT_COUNT`는 request budget과 정확히 같아야 한다.

## 대용량 seed, checkpoint와 재개

`api-array` 방식은 로컬 축소 실행 전용이고 최대 25,000좌석이다. 수백만 행을 Node.js나 k6 메모리 배열로 만들지 않는다. 원격 실행용 `chunked-bulk` provisioner는 후속 단계에서 다음 계약으로 구현한다. 현재 11단계 runner는 해당 provisioner 없이 원격 실행을 fail-closed한다.

1. 전용 환경에서만 `run_id`, 환경 ID, 목표 행 수, chunk 크기, 입력 hash가 있는 seed job을 생성한다.
2. 사용자·event·performance를 먼저 만들고 좌석은 기본 1,000행 단위 bulk insert로 생성한다. 각 chunk는 독립 transaction이다.
3. commit 후 `last_committed_chunk`, 시작·끝 sequence, 실제 행 수와 checksum을 checkpoint 테이블에 기록한다. 메모리에는 현재 chunk만 둔다.
4. 재개 시 입력 hash와 환경 소유권을 다시 확인하고, 완료 checkpoint의 실제 행과 checksum을 대조한 뒤 첫 미완료 chunk부터 시작한다. 부분 transaction은 rollback하고 재실행한다.
5. Redis warm seed도 `REDIS_KEY_PREFIX` 아래에서 chunk 처리하고, 생성 key를 run별 set 또는 stream에 기록한다. prefix 바깥 key는 만들지 않는다.
6. 완료 후 DB 실제 행 수, Redis key 수, 용량과 manifest를 preflight 예상치와 비교한다. 차이가 있으면 부하를 시작하지 않는다.

정확한 cleanup은 checkpoint 범위와 최종 `fixture-manifest.json`의 ID만 사용한다. reservation → seat → performance → event → user 순으로 chunk 삭제하고, run별 Redis key 목록을 삭제한다. 각 chunk 삭제 수를 checkpoint에 기록해 재개할 수 있어야 한다. 마지막에 해당 run의 DB 행·Redis key·queue 메시지가 0이고 다른 run ID가 보존됐음을 확인한 뒤 seed job을 `CLEANED`로 표시한다. 범용 wildcard, DB 전체 truncate, 공유 prefix 삭제는 금지한다.

## 인증 TTL

preflight는 다음 합을 토큰의 최소 TTL로 계산한다.

```text
required TTL = setup allowance + load duration + drain allowance
             + audit allowance + safety allowance
```

기본 `LOAD_ACCESS_TOKEN_TTL=2h`는 기본 Spike의 약 47분 30초와 기본 Soak의 102분 요구량을 덮는다. 부족하면 실행을 거부한다. 명시적 테스트 TTL은 `K6_ACCESS_TOKEN_TTL_SECONDS`로 앱에 전달하며 `NODE_ENV!=production`, `ENABLE_TEST_PREFLIGHT=true`, `TEST_ENVIRONMENT=local-disposable`일 때만 5분~24시간 범위에서 허용한다. 운영·공유 환경에서는 앱 시작 단계에서 거부한다. preflight health와 metadata의 TTL이 일치해야 한다. 401은 expected conflict나 capacity 오류가 아니라 예상하지 않은 오류로 집계하며 자동 중단 대상이다.

## 동일 시간 범위 모니터링

관측 창은 artifact의 UTC `startedAt` 직전 baseline snapshot부터 부하 종료, queue drain과 최종 감사 직후 `endedAt`까지다. 모든 대시보드와 export는 이 UTC 범위를 사용한다.

| 영역      | 동일 창에서 수집할 항목                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 앱        | 요청·outcome·enqueue·processed counter, queue depth/processing/retry/DLQ, persistence histogram, RSS, heap, event-loop lag, process start time |
| PM2       | worker별 CPU/RSS, restart count, unstable restart와 exit reason                                                                                |
| ALB       | healthy/unhealthy target, target 4xx/5xx, response time, rejected connection                                                                   |
| Redis     | used memory, ops/s, connected clients, eviction, timeout/command failure, stream length와 pending                                              |
| DB        | active/idle connection과 `max_connections`, transaction commit/rollback, CPU·IO·storage, lock/wait, query latency                              |
| k6 발생기 | CPU, VU, started/completed, dropped iteration, 네트워크 오류                                                                                   |

로컬 watchdog은 앱 `/metrics`, PostgreSQL `pg_stat_database`, Redis `INFO`, k6 process CPU를 직접 polling한다. PM2와 ALB가 없는 일회성 로컬 환경은 artifact에 `unavailable_in_local_disposable_environment`로 명시한다. 원격 Gate에서는 PM2와 ALB adapter가 `available`이 아니면 시작하지 않는다.

## 자동 watchdog과 중단 기준

기본 polling은 2초, 연속 위반 횟수는 3회다. 한 번의 순간값은 기록하되 자동 중단은 연속 위반으로 결정한다. RDS·Redis CPU/메모리는 CloudWatch의 서로 다른 1분 datapoint만 연속 표본으로 계산하며, 캐시를 2초마다 반복 읽은 값은 횟수를 늘리거나 초기화하지 않는다. 따라서 qualification Run은 최소 `연속 위반 횟수 × 60초`여야 하며, 종료 시 독립 datapoint가 부족하면 `WATCHDOG_CLOUDWATCH_COVERAGE_INSUFFICIENT`로 무효 처리한다. 중단 시 watchdog은 `.watchdog.json.tmp`를 먼저 원자적으로 기록하고 k6에 `SIGINT`를 보낸다. runner는 결과를 `ABORTED/WATCHDOG_ABORTED`로 finalize하며 중단 사유, 최대값, polling 설정과 표본 수를 `server-metrics.json` 및 `metadata.json`에 보존한다.

EC2 CPU credit은 기본 모니터링의 5분 datapoint를 사용한다. preflight는 현재 보수적 잔액이 기준 미만이면 즉시 거부한다. Run 중에는 마지막 실제 최솟값에서 `t3.small`의 2 vCPU가 분당 최대 2 credit을 모두 소비하고 credit 적립은 없다고 가정한 하한을 2초마다 계산한다. 이 하한이 3회 연속 기준 미만이면 중단하므로 5분짜리 다음 datapoint를 기다리지 않으며, 실제 잔액보다 낙관적으로 판단하지 않는다.

| 조건                 | 초기 기준                                  | 자동 동작                                                      |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| 예상하지 않은 오류   | delta 오류율 > 0.1%, 3회                   | watchdog 중단; k6 `unexpected_error_rate`도 6초 이후 즉시 중단 |
| ALB unhealthy target | 1개 이상, 3회                              | 원격 adapter가 k6 중단; adapter 없으면 preflight 거부          |
| DB connection        | `numbackends / max_connections > 85%`, 3회 | watchdog 중단                                                  |
| RDS CPU              | 서로 다른 1분 datapoint가 기준 초과, 3회   | watchdog 중단; 표본 부족 qualification은 무효                  |
| Redis CPU·메모리     | 서로 다른 1분 datapoint가 기준 초과, 3회   | watchdog 중단; 표본 부족 qualification은 무효                  |
| EC2 CPU credit       | 2 vCPU 최대 소모 기준 보수적 하한, 3회     | preflight 즉시 거부 또는 watchdog 중단                         |
| Redis eviction       | baseline 이후 1개 이상                     | 3회 확인 후 중단                                               |
| Redis/관측 timeout   | 입력 조회 실패 3회                         | `WATCHDOG_INPUT_UNAVAILABLE`로 중단                            |
| event-loop lag       | 200 ms 초과, 3회                           | watchdog 중단                                                  |
| queue depth          | 승인 상한 10,000 초과, 3회                 | watchdog 중단                                                  |
| 앱 restart           | process start 변화 또는 PM2 restart 증가   | 3회 확인 후 중단                                               |
| k6 발생기 CPU        | 90% 초과, 3회                              | watchdog 중단                                                  |
| dropped iteration    | 1개 이상                                   | k6 threshold가 중단                                            |

부하가 끝나면 producer를 `COMPLETED`로 바꾸고 자동 drain 감사가 100 ms 간격으로 queue·in-flight를 확인한다. 1초 안정 구간 안에 모두 0이어야 하며 30초 안에 감소·종료하지 않으면 `DRAIN_TIMEOUT`/`DRAIN_SLO_EXCEEDED`로 실패한다. 화면을 사람이 지켜보는 것은 중단 장치로 인정하지 않는다.

## Verdict

### Spike recovery

다음을 모두 만족해야 full profile이 `recovery/PASS`다.

- peak와 recovery accepted latency가 각각 p95 < 200 ms, p99 < 500 ms.
- recovery의 오류·timeout과 전체 dropped iteration이 0.
- recovery p95 / baseline p95가 `SPIKE_RECOVERY_MAX_LATENCY_RATIO`(기본 2.0) 이하.
- 회복은 recovery 관찰 구간(기본 3분) 안에서 확인되고 post-load drain은 30초 미만.
- watchdog 중단, restart, Redis eviction, 관측 누락이 없고 persistence p95 ≤ 2초.
- accepted → processed → persisted reservation ID 집합과 request manifest가 정확히 일치.

현재 artifact의 `recoveryWindowUpperBoundMs`는 회복 시간의 상한이다. 더 정밀한 초 단위 회복 시각은 원격 시계열에서 같은 UTC 창의 latency·error·queue가 baseline 범위로 연속 3회 돌아온 최초 시점으로 계산한다.

### Soak endurance

다음을 모두 만족해야 full profile이 `endurance/PASS`다.

- 6개 동일 시간 구간 모두 accepted p95 < 200 ms, p99 < 500 ms이며 오류·timeout·drop이 0.
- RSS가 시작 대비 10% 넘게 증가하면서 표본의 80% 넘게 연속 증가하는 추세가 없음.
- queue의 지속 증가, restart, Redis eviction, 관측 누락이 없음.
- post-load drain < 30초, persistence p95 ≤ 2초, 최종 request/reservation ID 감사 통과.

축소 실행은 위 연결 검사를 통과해도 각각 `recovery-preflight/NOT_APPLICABLE`, `endurance-preflight/NOT_APPLICABLE`이다.

## 실행과 사후 절차

로컬 축소 연결 검증은 다음 전용 runner만 사용한다.

```bash
k6/tools/run-local-integration.sh spike
k6/tools/run-local-integration.sh soak
```

각 실행 뒤 다음 순서로 확인한다.

1. `metadata.json`이 `COMPLETED`, `FINALIZED`, `preflight=VERIFIED`인지 확인한다.
2. `summary.json`의 dropped, phase/window latency, 오류·timeout과 offered/start/completed를 확인한다.
3. `server-metrics.json`의 watchdog status·최대 자원값·queue·persistence와 동일 UTC 창을 확인한다.
4. `consistency-audit.json`의 drain, queue 0, ID 집합, request manifest, experiment verdict를 확인한다.
5. checksum을 검증하고 artifact에 credential 또는 접속 문자열이 없는지 검사한다.
6. `node k6/tools/cleanup.mjs --dry-run`으로 exact ID 삭제 계획을 검토한 뒤 승인된 cleanup을 수행한다.
7. DB/Redis/queue 잔존량 0과 타 run 보존을 확인하고 비용 자원을 종료한다.

정적 inspect만 통과하면 `STATIC_VERIFIED`, 일회성 앱·DB·Redis에서 축소 실행의 watchdog·drain·ID 감사까지 통과한 경우에만 11단계를 `INTEGRATION_VERIFIED`로 기록한다. 원격 profile을 실제 실행하기 전에는 `REMOTE_VERIFIED`를 사용하지 않는다.

## 12단계 원격 실행

원격 실행은 [AWS 부하 테스트 환경 README](../../infra/load-test/README.md)의 승인된 `k6/run-remote` 경로만 사용한다. 맥북에서는 S3의 버전 고정 승인 파일을 검증하고 SSM 명령만 전달하며, 실제 k6와 감사·cleanup은 VPC 내부 `c7i-flex.large` 발생기에서 수행한다. 원래 계획의 `c7i.large`는 이 계정의 프리 티어 제한으로 AWS가 거부하므로 같은 2 vCPU·4 GiB 사양의 허용 유형으로 교체했다.

실행 준비 순서는 `k6/manage-remote-generator start --execute`로 임시 발생기를 만든 뒤, `k6/prepare-remote-approval`로 실사값이 채워진 초안을 생성하고 승인자가 검토한 파일만 `k6/publish-remote-approval --publish`로 게시하는 것이다. 발생기 ID가 승인서에 고정되므로 이 순서를 바꾸면 안 된다. 정식 실행은 `k6/execute-remote-session ... --execute`를 사용해 종료 시 Terraform 발생기 삭제까지 시도한다. 발생기에는 26시간 자기 종료 안전장치가 있지만 정상 cleanup을 생략할 근거로 사용하지 않는다.

승인 파일은 [JSON Schema](../../k6/remote/remote-approval.schema.json)를 만족해야 한다. 환경·시간창·시나리오·정확한 실행 profile·fixture 상한·기준선/후보/runner digest·인프라·담당자·중단 기준·cleanup 권한을 누락할 수 없다. runner는 승인 파일을 만들거나 수정하지 않으며 approval ID, S3 Version ID, SHA-256과 `--execute` 중 하나라도 없으면 실행하지 않는다.

`validate`는 다음을 실행 없이 확인하고 Run 행렬만 출력한다.

1. 승인 schema, checksum, S3 버전과 활성 시간창
2. 3·4·7·11단계 `INTEGRATION_VERIFIED`와 `NO_GO=false`
3. AWS 계정·서울 리전, internal ALB, healthy target 7개
4. `t3.small` 7대, `c7i-flex.large` 발생기, `db.t4g.micro`, `cache.t3.micro`
5. S3 버전 관리·암호화·공개 차단과 원본 시계열 90일 보존
6. VU/RPS·기간·요청 수·fixture 행/바이트·토큰 TTL 상한

`execute`는 이미지 digest별로 대표 노드 migration 1회와 7대 순차 배포를 완료하고 모든 ALB target이 healthy이며 동일 SHA/digest 태그인지 확인한 뒤 실행한다. 각 Run 직전 승인 파일과 AWS 실사값을 다시 읽고, 14개 worker·7개 PM2 exporter·DB·Redis·ALB·CloudWatch·발생기 CPU의 watchdog preflight를 통과해야 k6를 시작한다.

각 Run은 `producer 종료 → drain → ID 감사 → cleanup dry-run → exact cleanup → 외부 Run 보존 확인 → S3 업로드 → checksum 봉인` 순서를 완료해야 한다. 어느 단계든 실패하면 다음 Run으로 올라가지 않는다. 실패하거나 중단된 Run도 가능한 metadata와 산출물을 보존하며 성공으로 바꾸지 않는다.

기준선과 후보 비교는 같은 runner digest, 인프라 descriptor hash, profile hash, fixture 방식, cache/tracing 설정으로 실행된 100% 확정 Run 3회에만 허용한다. `candidate-only` 승인은 후보 절대값만 보고하며 개선율을 작성하지 않는다. 실제 AWS 실행을 하지 않은 코드·Terraform 검증 상태는 `STATIC_VERIFIED`이며 `REMOTE_VERIFIED`가 아니다.
