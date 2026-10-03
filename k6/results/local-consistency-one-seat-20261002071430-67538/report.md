# k6 Run local-consistency-one-seat-20261002071430-67538

## 목표

consistency-one-seat 요청 manifest, 접수 ID와 비동기 처리 후 DB 영속화 ID가 정확히 일치하는지 검증한다.

## 조건

- Test environment: k6int2026100207143067538
- VU / RPS / duration: 4 / 1 / 5s
- Cache profile: cold
- Expected accepted / conflict: 1 / 3
- Performance ID: cmuqmo59n0005bv7toxvl5s7e

## 핵심 수치

- Accepted reservations: 1
- Persisted reservations: 1
- Request attempts: 4
- Drain time: 1046ms
- Pending / processing / retry / DLQ: 0 / 0 / 0 / 0

## 정합성 결과

- Verdict: FAIL
- Reasons: EXPECTED_CONFLICT_MISMATCH, UNEXPECTED_ERROR_OBSERVED

## 한계

- 애플리케이션 시계열 수집기가 없어 앱 지표는 unavailable로 기록했다.
- 이 Run은 정합성 검증이며 처리량 한계를 입증하지 않는다.

## 다음 결정

- 후속 부하 단계를 중단하고 실패 ID와 queue 상태를 조사한다.
