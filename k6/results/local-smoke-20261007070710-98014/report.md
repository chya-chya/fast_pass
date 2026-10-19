# k6 Run local-smoke-20261007070710-98014

## 목표

smoke 요청 manifest, 접수 ID와 비동기 처리 후 DB 영속화 ID가 정확히 일치하는지 검증한다.

## 조건

- Test environment: k6int2026100707071098014
- VU / RPS / duration: 1 / 1 / 5s
- Cache profile: warm
- Expected accepted / conflict: 1 / 0
- Performance ID: cmuxrm0yv0002qc7t9en923k0

## 핵심 수치

- Accepted reservations: 1
- Persisted reservations: 1
- Request attempts: not applicable
- Drain time: 1064ms
- Pending / processing / retry / DLQ: 0 / 0 / 0 / 0

## 정합성 결과

- Verdict: PASS
- Reasons: none

## 한계

- 애플리케이션 시계열 수집기가 없어 앱 지표는 unavailable로 기록했다.
- 이 Run은 정합성 검증이며 처리량 한계를 입증하지 않는다.

## 다음 결정

- ID 감사 기반을 후속 정합성 시나리오에 재사용한다.
