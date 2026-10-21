# k6 Run local-capacity-rps-20261010030354-15891

## 목표

explore arrival-rate의 offered/start/enqueue/completed RPS와 최종 ID 정합성을 기록한다.

## 조건

- Test environment: k6int2026101003035415891
- VU / target RPS / duration: 10 / 4 / 9000ms
- Cache profile: warm
- RPS test / data profile: explore / hot-seat
- Executor / timeUnit: ramping-arrival-rate / 1s
- Pre-allocated / max VUs: 4 / 10
- Request budget: 64
- Expected accepted / conflict: 1 / 19
- Performance ID: cmv1t8ovo000bf57t60n15elg

## 핵심 수치

- Accepted reservations: 1
- Persisted reservations: 1
- Request attempts: 20
- Offered / started / server enqueue / completed count: 20 / 20 / 1 / 20
- Offered / started / server enqueue / completed RPS: 2.22 / 2.22 / 0.11 / 2.22
- Dropped iterations: 0
- Drain time: 1070ms
- Pending / processing / retry / DLQ: 0 / 0 / 0 / 0

## 정합성 결과

- Verdict: PASS
- Reasons: none
- RPS verdict: exploratory / LIMIT_NOT_FOUND
- RPS verdict reasons: none

## 한계

- 애플리케이션 지표는 Run 시작·종료 `/metrics` snapshot의 차이로 기록했다.
- DB·Redis는 종료 시점 snapshot이며 세부 시계열은 아직 수집하지 않는다.
- 이 Run은 한계·붕괴 관찰용이며 지속 가능한 처리량 PASS 근거가 아니다.

## 다음 결정

- offered/start/enqueue/completed RPS, drop, latency, 자원과 queue drain을 함께 보고 다음 탐색 또는 확정 비율을 결정한다.
