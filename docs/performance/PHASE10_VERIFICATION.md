# 10단계 RPS Capacity 시나리오 검증

## 판정

**구현 Gate: `STATIC_VERIFIED`**

열린 부하 모델의 탐색·확정 시나리오, 정상 성공·충돌 데이터 분리, 네 가지 RPS 경계, 결과 저장·queue drain·DB 감사를 정적으로 검증했다. 추가로 1→2→3→4 RPS 탐색과 4 RPS 확정을 전용 일회성 로컬 앱·PostgreSQL·Redis에서 축소 실행했지만, 이 결과를 기본 100→1,000 RPS capacity나 지속 가능한 처리량 근거로 사용하지 않는다. 원격 부하는 실행하지 않았다.

## 실행 모델

| profile       | executor                | 기본 rate                     | duration | 판정                                         |
| ------------- | ----------------------- | ----------------------------- | -------- | -------------------------------------------- |
| `explore`     | `ramping-arrival-rate`  | `100 → 300 → 500 → 1,000 RPS` | 45초     | `LIMIT_FOUND` / `LIMIT_NOT_FOUND` 탐색       |
| `confirm-50`  | `constant-arrival-rate` | 250 RPS                       | 30초     | SLO + drop 0의 `PASS/FAIL`                   |
| `confirm-75`  | `constant-arrival-rate` | 375 RPS                       | 30초     | SLO + drop 0의 `PASS/FAIL`                   |
| `confirm-100` | `constant-arrival-rate` | 500 RPS                       | 30초     | SLO + drop 0의 `PASS/FAIL`                   |
| `confirm-110` | `constant-arrival-rate` | 550 RPS                       | 30초     | 붕괴 관찰, 안정 처리량 판정 `NOT_APPLICABLE` |

모든 profile은 `timeUnit=1s`이며 다른 값은 설정 검증에서 거부한다. 각 iteration은 예약 HTTP 요청 하나만 보내고 arrival-rate 함수에는 `sleep`이 없다. `RPS_RATE=500`이 한계 후보의 100%이며 50/75/110%는 이를 기준으로 계산한다.

기본 탐색의 `preAllocatedVUs=500`, `maxVUs=1,000`은 각각 최대 offered rate에서 약 500ms와 1초의 동시 처리 여유를 둔 값이다. 확정 profile은 선택한 rate의 50%를 pre-allocation, 100%를 max VU로 사용한다. 이는 load generator 용량 설정이며 서버 capacity 수치가 아니다. 이전 실행의 지연과 drop을 보고 환경변수로 늘릴 수 있다.

## 처리량 경계와 데이터 분리

- offered iteration: 시작한 예약 요청과 `dropped_iterations`의 합
- started request: 실제 예약 HTTP 호출을 시작한 수
- server enqueue: 서버 `reservation_queue_total{status="success"}` 증가분
- completed response: 응답을 받아 outcome 분류까지 마친 수

`summary.json`은 offered/start/completed 수와 RPS, 탐색 target별 start/completed RPS를 저장한다. `server-metrics.json`은 같은 측정창의 enqueue 수와 RPS를 저장한다. 탐색에서 drop·지연·요청 품질 중 깨진 신호는 verdict의 `reasons`와 `failedMetrics`로 보존한다.

`unique-seat`는 request budget만큼 고유 좌석을 준비하고 전역 `iterationInTest`로 request ID·좌석을 배정한다. `hot-seat`는 전역 request ID를 유지하되 좌석 하나만 사용한다. 최초 accepted 이후의 `expected_conflict` 409는 별도 outcome이며 server enqueue 또는 정상 예약 처리량으로 해석하지 않는다. 로컬 `__VU`는 배정 키로 사용하지 않는다.

## 축소 통합 실행

clean source에서 다음 세 Run이 전체 경로를 통과했다.

| Run                                       | profile                   | offered / started / enqueue / completed | outcome                          | verdict                         |
| ----------------------------------------- | ------------------------- | --------------------------------------- | -------------------------------- | ------------------------------- |
| `local-capacity-rps-20261010030707-18786` | explore + unique-seat     | `19 / 19 / 19 / 19`, drop 0             | accepted 19, conflict 0          | `exploratory / LIMIT_NOT_FOUND` |
| `local-capacity-rps-20261010030753-19522` | confirm-100 + unique-seat | `20 / 20 / 20 / 20`, 각 4 RPS, drop 0   | accepted 20, conflict 0          | `capacity-confirmation / PASS`  |
| `local-capacity-rps-20261010030834-20194` | explore + hot-seat        | `19 / 19 / 1 / 19`, drop 0              | accepted 1, expected conflict 18 | `exploratory / LIMIT_NOT_FOUND` |

- 모든 Run은 `gitDirty=false`, `execution=COMPLETED`, `artifactSet=FINALIZED`, preflight/consistency/observability PASS다.
- 모든 Run은 pending/processing/retry/DLQ와 worker in-flight가 `0/0/0/0/0`, conservation difference가 0이다.
- 탐색 두 Run의 축소 target은 1→2→3→4 RPS, ramp/hold는 각각 1초이며 9초 측정창의 평균 start/completed는 약 2.11 RPS다.
- 세 Run의 scenario script SHA-256은 `dbef10983c62913a8c9e2e43a9106d422735921bb0062dadb5c3cc97592cfed4`로 같다.

증거:

- [`unique-seat` 탐색 Run](../../k6/results/local-capacity-rps-20261010030707-18786/)
- [`unique-seat` 100% 확정 Run](../../k6/results/local-capacity-rps-20261010030753-19522/)
- [`hot-seat` 탐색 Run](../../k6/results/local-capacity-rps-20261010030834-20194/)

`local-capacity-rps-20261010030300-14863`, `local-capacity-rps-20261010030330-15393`, `local-capacity-rps-20261010030354-15891`은 최종 커밋 전 기능 연결을 확인한 dirty 진단 Run이며 최종 근거로 사용하지 않는다.

## 검증 결과

- `npm run build`: 통과
- k6 Node 테스트: 57/57 통과
- `TestRunController` Jest: 8/8 통과
- controller/spec ESLint: 통과
- 셸 구문 검사: 통과
- `k6 inspect --execution-requirements`: 탐색, confirm-100, confirm-110 통과
- inspect 확인: 탐색 `ramping-arrival-rate`, 확정 `constant-arrival-rate`, `timeUnit=1s`, rate/duration/preAllocatedVUs/maxVUs, 안정 확정에만 drop 0 threshold
- 새 시나리오의 stages 안에 무효한 `rate` 필드가 없고 `sleep` 호출도 없음
- `git diff --check`: 통과
- 원격 부하: 실행하지 않음

## 남은 경계

- 기본 100→1,000 RPS 탐색과 250/375/500/550 RPS 확정은 실행하지 않았다.
- 축소 confirm-100은 5초간 4 RPS로 1회 실행한 연결 검증이며, 최소 3회 재현 조건과 원격 시계열 자격을 충족하지 않는다.
- `confirm-110`은 정적으로만 검증했다. 실제 붕괴·회복 관찰은 후속 승인 실행에서 수행해야 한다.
- 로컬 artifact의 DB·Redis는 종료 snapshot이다. 실제 qualification에는 단계별 CPU, event-loop, DB/Redis, queue 증가율과 회복 시계열 원본이 필요하다.
