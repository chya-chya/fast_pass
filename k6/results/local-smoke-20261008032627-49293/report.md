# k6 Run local-smoke-20261008032627-49293

## 목표

smoke 요청 manifest, 접수 ID와 비동기 처리 후 DB 영속화 ID가 정확히 일치하는지 검증한다.

## 조건

- Test environment: k6int2026100803262749293
- VU / RPS / duration: 1 / 1 / 5s
- Cache profile: warm
- Expected accepted / conflict: 1 / 0
- Performance ID: cmuyz60t90002567tg7q1xjby

## 핵심 수치

- Accepted reservations: 1
- Persisted reservations: 1
- Request attempts: not applicable
- Drain time: 1062ms
- Pending / processing / retry / DLQ: 0 / 0 / 0 / 0

## 정합성 결과

- Verdict: PASS
- Reasons: none

## 한계

- 애플리케이션 지표는 Run 시작·종료 `/metrics` snapshot의 차이로 기록했다.
- DB·Redis는 종료 시점 snapshot이며 세부 시계열은 아직 수집하지 않는다.
- 이 Run은 정합성 검증이며 처리량 한계를 입증하지 않는다.

## 다음 결정

- ID 감사 기반을 후속 정합성 시나리오에 재사용한다.
