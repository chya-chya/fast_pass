# k6 Run local-soak-20261010040231-64763

## 목표

지속 부하 구간의 지연, 메모리·queue 추세, 재시작과 최종 ID 정합성을 기록한다.

## 조건

- Test environment: k6int2026101004023164763
- VU / target RPS / duration: 10 / 3 / 8000ms
- Cache profile: warm
- Reduced / timeUnit: true / 1s
- Pre-allocated / max VUs: 3 / 10
- Scheduled / budget requests: 24 / 64
- Authentication TTL / required: 900s / 248s
- Watchdog poll / consecutive violations: 500ms / 3
- Expected accepted / conflict: 25 / 0
- Performance ID: cmv1vc2zl000b5l7t1xckuf6k

## 핵심 수치

- Accepted reservations: 25
- Persisted reservations: 25
- Request attempts: 25
- Offered / started / server enqueue / completed count: 25 / 25 / 25 / 25
- Dropped iterations: 0
- Maximum queue depth: 1
- Persistence p95 upper bound: 0.25s
- Watchdog max DB ratio / event-loop lag / generator CPU: 0.02 / 4.0725ms / 2%
- Watchdog Redis evictions / process restarts: 0 / 0
- Drain time: 1100ms
- Pending / processing / retry / DLQ: 0 / 0 / 0 / 0

## 정합성 결과

- Verdict: PASS
- Reasons: none
- Experiment verdict: endurance-preflight / NOT_APPLICABLE
- Experiment reasons: none

## 한계

- 애플리케이션 지표는 Run 시작·종료 `/metrics` snapshot의 차이로 기록했다.
- DB·Redis는 종료 시점 snapshot이며 세부 시계열은 아직 수집하지 않는다.
- 축소 Run은 watchdog·drain·감사 연결 검증이며 Spike 회복성 또는 Soak 지속성을 입증하지 않는다.

## 다음 결정

- watchdog 최대값, 구간별 SLO, queue drain, DB ID 감사와 자원 추세를 함께 검토한다.
