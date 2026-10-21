# k6 Run local-capacity-vu-20261008033939-55346

## 목표

unique-seat VU 탐색의 실제 RPS, outcome별 지연, 자원 포화와 최종 ID 정합성을 기록한다.

## 조건

- Test environment: k6int2026100803393955346
- VU / target RPS / duration: 4 / not set / 13000ms
- Cache profile: warm
- Capacity profile: unique-seat
- User behavior / think time: reserve-then-think / 1s
- Request budget: 64
- Expected accepted / conflict: 30 / 0
- Performance ID: cmuyzmykz0005sl7tjywirtoc

## 핵심 수치

- Accepted reservations: 30
- Persisted reservations: 30
- Request attempts: 30
- Stage 1 (1 VU) actual RPS: 0.67
- Stage 2 (2 VU) actual RPS: 1.67
- Stage 3 (3 VU) actual RPS: 2.67
- Stage 4 (4 VU) actual RPS: 3.75
- Drain time: 1071ms
- Pending / processing / retry / DLQ: 0 / 0 / 0 / 0

## 정합성 결과

- Verdict: PASS
- Reasons: none
- Capacity verdict: exploratory / NOT_APPLICABLE
- SLO threshold observation: within thresholds

## 한계

- 애플리케이션 지표는 Run 시작·종료 `/metrics` snapshot의 차이로 기록했다.
- DB·Redis는 종료 시점 snapshot이며 세부 시계열은 아직 수집하지 않는다.
- 이 탐색 Run은 고정 RPS 회귀 PASS/FAIL이나 지속 가능한 처리량을 입증하지 않는다.

## 다음 결정

- 단계별 실제 RPS, outcome latency, 앱·DB·Redis 지표와 queue drain을 함께 보고 다음 탐색 범위를 결정한다.
