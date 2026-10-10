# k6 Run local-capacity-rps-20261010030753-19522

## 목표

confirm-100 arrival-rate의 offered/start/enqueue/completed RPS와 최종 ID 정합성을 기록한다.

## 조건

- Test environment: k6int2026101003075319522
- VU / target RPS / duration: 10 / 4 / 5000ms
- Cache profile: warm
- RPS test / data profile: confirm-100 / unique-seat
- Executor / timeUnit: constant-arrival-rate / 1s
- Pre-allocated / max VUs: 4 / 10
- Request budget: 64
- Expected accepted / conflict: 20 / 0
- Performance ID: cmv1tdtk0000b6h7tj1zivilq

## 핵심 수치

- Accepted reservations: 20
- Persisted reservations: 20
- Request attempts: 20
- Offered / started / server enqueue / completed count: 20 / 20 / 20 / 20
- Offered / started / server enqueue / completed RPS: 4.00 / 4.00 / 4.00 / 4.00
- Dropped iterations: 0
- Drain time: 1073ms
- Pending / processing / retry / DLQ: 0 / 0 / 0 / 0

## 정합성 결과

- Verdict: PASS
- Reasons: none
- RPS verdict: capacity-confirmation / PASS
- RPS verdict reasons: none

## 한계

- 애플리케이션 지표는 Run 시작·종료 `/metrics` snapshot의 차이로 기록했다.
- DB·Redis는 종료 시점 snapshot이며 세부 시계열은 아직 수집하지 않는다.
- 확정 profile은 같은 조건을 최소 3회 재현하기 전에는 지속 가능한 처리량 근거가 아니다.

## 다음 결정

- offered/start/enqueue/completed RPS, drop, latency, 자원과 queue drain을 함께 보고 다음 탐색 또는 확정 비율을 결정한다.
