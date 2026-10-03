# 5단계 검증 기록

## 판정

- 실행일: 2026-10-02
- 최종 상태: `INTEGRATION_VERIFIED`
- 검증 범위: 단일 좌석 충돌, 균등 inventory 경쟁, Warm/Cold Cache, 요청 manifest와 queue/DB ID 감사
- 원격 요청·부하 테스트: 실행하지 않음
- 1,000 VU 실제 실행: 실행하지 않음. 기본 프로필은 `k6 inspect`와 단위 테스트로만 검증함

전용 일회성 앱·PostgreSQL·Redis에서 4 VU 축소 실행을 수행했다. 네 실행 모두 실제 요청 manifest, 좌석별 요청 분배, accepted/conflict 수, queue drain, 처리 ID와 DB 저장 ID가 정확히 일치했다.

## 시나리오와 결정적 배정

| 시나리오                | 기본 VU × iteration | 좌석 | 기대 결과                                 |
| ----------------------- | ------------------: | ---: | ----------------------------------------- |
| `consistency-one-seat`  |              10 × 1 |    1 | accepted 1, conflict 9                    |
| `consistency-inventory` |           1,000 × 1 |   50 | accepted 50, conflict 950, 좌석별 요청 20 |

각 요청은 `k6/execution`의 `scenario.iterationInTest`를 전역 iteration ID로 사용한다. 요청 ID는 `<run-id>-req-<6자리 전역 iteration ID>`이고, 사용자와 좌석은 각각 `globalIterationId % userCount`, `globalIterationId % seatCount`로 배정한다. `__VU`, 난수 좌석 선택과 실행기 로컬 순서에는 의존하지 않는다.

Setup은 회원가입·로그인, 이벤트·공연·좌석 생성, fixture 등록과 캐시 프로필 적용을 모두 측정 구간 밖에서 수행한다. 실제 결과 artifact에는 performance ID와 데이터셋 조건만 남기고 token·password·연결 문자열은 저장하지 않는다.

## Warm/Cold Cache

- `CACHE_PROFILE=warm`: fixture에 속한 정확한 좌석 key만 `AVAILABLE`로 설정하고 값을 다시 읽어 검증한다.
- `CACHE_PROFILE=cold`: 같은 fixture 좌석 key만 삭제하고 부재를 다시 읽어 검증한다.
- 캐시 프로필 제어 endpoint는 production에서 숨겨지고, 일회성 환경 identity와 preflight token을 통과한 요청만 허용한다.

Cold Cache에서는 최초 cache miss 요청만 `CHECKING` marker를 원자적으로 선점하고 DB 확인을 수행한다. 후속 요청은 선두 요청이 실제로 `HELD` 또는 `RESERVED` 상태를 만든 경우에만 정상 충돌로 분류한다. Redis·DB·lock 오류나 marker timeout은 409로 숨기지 않고 시스템 오류로 유지한다.

## 사후 감사

서버는 좌석 상태를 변경하기 전에 각 테스트 요청의 request ID, user ID, seat ID를 run 전용 Redis hash에 한 번만 기록한다. 감사 단계는 compact fixture recipe에서 기대 manifest를 다시 만들고 다음을 모두 검사한다.

- 전체 request ID 집합과 요청 수
- request ID별 user/seat 배정
- 좌석별 실제 요청 수와 사전 계산 분포
- exact accepted/conflict/iteration 수, unexpected error와 timeout 0
- accepted, processed, persisted reservation ID 집합
- pending/processing/retry/DLQ/in-flight drain과 보존식
- 실제 적용된 cache profile

하나라도 다르면 artifact는 실패 사유와 함께 봉인되며 정합성 PASS가 되지 않는다.

## 격리 축소 실행 결과

| Run ID                                             | Profile | 데이터셋                | HTTP 결과               | DB 저장 | Manifest/ID 감사 |
| -------------------------------------------------- | ------- | ----------------------- | ----------------------- | ------: | ---------------- |
| `local-consistency-one-seat-20261002071339-66737`  | warm    | 4요청 / 1좌석           | 1 accepted / 3 conflict |       1 | PASS             |
| `local-consistency-inventory-20261002071357-67114` | warm    | 4요청 / 2좌석, 좌석별 2 | 2 accepted / 2 conflict |       2 | PASS             |
| `local-consistency-one-seat-20261002071546-68317`  | cold    | 4요청 / 1좌석           | 1 accepted / 3 conflict |       1 | PASS             |
| `local-consistency-inventory-20261002071609-68769` | cold    | 4요청 / 2좌석, 좌석별 2 | 2 accepted / 2 conflict |       2 | PASS             |

각 Run은 `execution=COMPLETED`, `artifactSet=FINALIZED`, threshold PASS, consistency audit PASS이며 checksum 검증도 통과했다. 컨테이너, 네트워크와 tmpfs 데이터는 실행 종료 시 제거했다.

Cold Cache 최초 진단 Run `local-consistency-one-seat-20261002071430-67538`은 후속 3건을 lock 오류로 분류해 실패했다. 실패 artifact를 보존한 채 cold miss leader/follower 상태 전이를 수정했고, 이후 두 cold Run에서 정확한 충돌 수와 ID 감사를 다시 통과했다. Runner 순서 오류로 preflight 뒤 중단된 `local-consistency-one-seat-20261002071308-66415`도 덮어쓰지 않고 `INCOMPLETE` 근거로 보존했다.

## 정적 검증

- Nest build 통과
- k6 Node 단위 테스트 35개 통과
- 관련 Jest 테스트 16개 통과
- `git diff --check` 통과
- 두 시나리오 `k6 inspect --execution-requirements` 통과
- inventory inspect: `per-vu-iterations`, 1,000 VU, VU당 1 iteration, accepted 50, conflict 950
- 단일·분할 global iteration 입력에서 동일 manifest와 좌석 분포를 만드는 단위 테스트 통과

## 보안 검토 반영

테스트 제어 endpoint는 production에서 404로 숨기고, preflight token과 전용 일회성 환경 조건을 모두 요구한다. 클라이언트가 임의 좌석 key를 전달하지 못하게 이미 검증·저장된 fixture의 정확한 좌석 ID만 사용한다. request manifest는 안전한 식별자와 최대 1,000건으로 제한하고 중복 request ID를 원자적으로 거부한다. 결과 artifact에는 token, password, DB/Redis URL을 기록하지 않는다.

## 한계

1,000 VU 실부하는 자동 실행하지 않았으므로 이 단계는 처리량·latency 한계나 1,000 VU 운영 성능을 입증하지 않는다. 분산 k6 실제 실행도 수행하지 않았으며, 전역 iteration 분할의 결정성은 단위 테스트로 검증했다. 원격 실행은 12단계 승인 manifest가 구현·승인될 때까지 계속 차단된다.
