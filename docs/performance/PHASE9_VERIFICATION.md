# 9단계 VU Capacity 시나리오 검증

## 판정

**구현 Gate: `STATIC_VERIFIED`**

`ramping-vus` 시나리오와 두 데이터 프로필, outcome별 지표, 결과 저장·사후 감사 연결을 정적으로 검증했다. 추가로 1→2→3→4 VU 축소 프로필을 전용 일회성 로컬 앱·PostgreSQL·Redis에서 실행했지만, 이 결과를 100→500→1,000→2,000 VU capacity 검증이나 지속 가능한 처리량 근거로 사용하지 않는다.

## 실행 모델

- executor: `ramping-vus`
- 기본 target: `100 → 500 → 1,000 → 2,000 VU`
- 기본 ramp: 각 30초, 종료 ramp 30초
- 기본 hold: 각 3분
- 목표 RPS: 없음
- 기본 사용자 행동: 예약 후 60초 think time
- profile: `unique-seat`, `hot-seat` 별도 Run

`CAPACITY_VU_STAGES`, `CAPACITY_RAMP_DURATION`, `CAPACITY_STAGE_HOLD_1`~`4`, `CAPACITY_USER_BEHAVIOR`, `CAPACITY_THINK_TIME`, `CAPACITY_REQUEST_BUDGET`을 metadata에 저장한다. 단계별 custom Counter의 요청 수를 측정창으로 나눠 실제 RPS를 계산한다.

## 데이터와 분산 배정

사용자·token, 이벤트·공연·좌석과 cache profile은 setup에서 준비해 측정 구간에서 제외한다. `unique-seat`는 `k6/execution`의 전역 `iterationInTest`를 고유 request ID와 좌석 index로 사용한다. `hot-seat`는 전역 request ID와 사용자 배정은 유지하고 좌석만 하나로 고정한다. 두 profile 모두 로컬 `__VU` 값에 의존하지 않는다.

fixture는 설정한 stage·think time으로 계산한 보수적 요청 예산 이상이어야 한다. `unique-seat`는 request budget과 같은 수의 고유 좌석을 요구하며, `hot-seat`는 정확히 한 좌석만 허용한다. 실행 후 실제 요청 수만큼 immutable 기대 manifest를 재구성해 요청 배정, accepted/expected conflict 수, processed/persisted ID와 queue drain을 감사한다.

## 지연과 verdict

- `accepted_duration_ms`: p95 < 200ms, p99 < 500ms
- `expected_conflict_duration_ms`: p95 < 200ms, p99 < 500ms
- `unexpected_error_duration_ms`: p95 < 500ms, p99 < 1,000ms
- `unexpected_error`, `timeout`: 0건

전체 `http_req_duration`을 정상 예약 latency로 사용하지 않는다. 결과의 verdict는 `kind=exploratory`, `status=NOT_APPLICABLE`이며 threshold 결과는 SLO 관측값으로만 저장한다. 고정 RPS 회귀 PASS/FAIL과 섞지 않는다.

## 축소 통합 실행

구현 중 dirty source에서 다음 두 Run이 전체 경로를 통과했다.

- `local-capacity-vu-20261008033939-55346`: `unique-seat`, 30 accepted, 30 persisted, conflict/unexpected 0
- `local-capacity-vu-20261008034009-55803`: `hot-seat`, accepted 1, expected conflict 29, unexpected 0
- 두 Run 모두 pending/processing/retry/DLQ 0, consistency/observability audit PASS

`local-capacity-vu-20261008033850-54886`은 미사용 fixture 좌석의 0건 분포를 실제 요청 분포와 비교하던 감사 오류를 fail-closed로 발견한 진단 Run이다. 기대 분포를 실제 요청 대상 좌석으로 제한한 뒤 두 profile이 통과했다.

clean source 최종 Run은 구현 커밋 뒤 별도로 기록한다.

## 검증 결과

- `npm run build`: 통과
- k6 Node 테스트: 48/48 통과
- `TestRunController` Jest: 7/7 통과
- 기본/Hot-seat `k6 inspect --execution-requirements`: 통과
- inspect 확인: `ramping-vus`, 100/500/1,000/2,000 target, 3분 hold, target RPS 없음, outcome별 p95/p99
- `git diff --check`: 통과
- 원격 부하: 실행하지 않음

## 남은 경계

- 기본 100→2,000 VU profile은 실행하지 않았다.
- 로컬 축소 Run의 단계별 실제 RPS는 기능 연결 확인값이며 capacity 수치가 아니다.
- 로컬 artifact의 DB·Redis는 종료 snapshot이다. 원격 qualification에는 단계별 CPU, event-loop, DB/Redis와 queue 시계열 원본이 필요하다.
