# 3단계 검증 기록

## 판정

- 실행일: 2026-10-01
- 최종 상태: `INTEGRATION_VERIFIED`
- Run ID: `local-smoke-20261001080401-39237`
- 기준 Git SHA: `9bac7e71a383de859a7c6bb2cdae966a7034c66b`
- Working tree: dirty
- 실행 build content SHA: `e810035675af37f9691ece47ce56a1db53ff2a49`

전용 일회성 로컬 앱·PostgreSQL·Redis에서 실제 Smoke를 수행하고, producer 종료와 queue 안정화를 확인한 뒤 accepted·processed·persisted 예약 ID 집합을 대조했다. 이 판정은 3단계 결과 저장 및 사후 감사 경로의 통합 검증이며 처리량 한계를 입증하지 않는다.

## 구현 범위

- Run별 fixture, summary, consistency audit, server metrics와 보고서를 임시 파일에서 원자적으로 확정한다.
- 필수 6개 artifact의 SHA-256을 생성하고 확정 후 다시 검증한다.
- 테스트 전용 endpoint와 request header로 Run 및 request 경계를 전달한다.
- Redis enqueue와 accepted ID 기록을 하나의 Lua 실행으로 묶는다.
- worker는 pending을 processing으로 원자 이동하고 성공·실패·in-flight·DLQ counter를 기록한다.
- cleanup은 별도 명령이며 dry-run을 기본값으로 둔다.

## 정적·단위 검증

다음 검사를 모두 통과했다.

- Node 단위 테스트 26개
- test health, Run endpoint, tracker Jest 테스트 8개
- Nest 애플리케이션 build
- k6 1.4.2 실행 요구사항 inspect
- k6 Compose 구성 해석
- shell 및 Node 구문 검사
- `git diff --check`
- no-clobber, 중간 실패, finalize 거부, checksum 변조 탐지 테스트
- 같은 건수이지만 ID가 다른 감사 실패, in-flight·DLQ 잔존 실패 테스트
- cleanup 소유권 불일치, 중복·위험 ID 거부 테스트

## 격리 통합 결과

1 VU, 1 RPS, 1 iteration, 5초 제한으로 실행했다.

| 항목                               |          결과 |
| ---------------------------------- | ------------: |
| Check                              |      2/2 통과 |
| Threshold                          |          통과 |
| Accepted / processed / persisted   |     1 / 1 / 1 |
| Pending / processing / retry / DLQ | 0 / 0 / 0 / 0 |
| Worker in-flight                   |             0 |
| 보존 법칙 차이                     |             0 |
| Drain 안정화                       |       1,048ms |
| 누락·초과 ID                       |         0 / 0 |
| 중복 좌석                          |             0 |

accepted reservation ID, worker processed ID와 DB persisted ID는 모두 `840ae2b3-f637-4084-a7d1-637c80e475a0`로 정확히 일치했다. 최종 판정은 `consistency.pass=true`이며 실패 사유는 없다.

DB 분포는 Reservation `PENDING=1`, Seat `HELD=1`, `AVAILABLE=4`였다. PostgreSQL과 Redis 직접 snapshot은 `available`로 기록했다. Run별 애플리케이션 시계열 수집기는 구성하지 않았으므로 앱 지표는 0으로 대신하지 않고 사유와 함께 `unavailable`로 기록했다.

## Artifact 증거

- [Metadata](../../k6/results/local-smoke-20261001080401-39237/metadata.json)
- [Fixture manifest](../../k6/results/local-smoke-20261001080401-39237/fixture-manifest.json)
- [Summary](../../k6/results/local-smoke-20261001080401-39237/summary.json)
- [Consistency audit](../../k6/results/local-smoke-20261001080401-39237/consistency-audit.json)
- [Server metrics](../../k6/results/local-smoke-20261001080401-39237/server-metrics.json)
- [Report](../../k6/results/local-smoke-20261001080401-39237/report.md)
- [Checksums](../../k6/results/local-smoke-20261001080401-39237/checksums.sha256)

모든 JSON은 파싱 검증을 통과했고 필수 artifact checksum 6개가 일치했다. 결과 디렉터리에서 token, password, JWT secret, DB/Redis 연결 문자열과 Bearer 값이 발견되지 않았다.

## Cleanup 안전성

보존된 fixture manifest에 대해 cleanup dry-run을 실행해 예약 1개, 좌석 5개, 공연 1개, 이벤트 1개, 사용자 1개와 해당 Run의 정확한 Redis key만 열거되는 것을 확인했다. wildcard, truncate, DB reset과 공유 key 삭제는 계획에 포함되지 않는다.

`--execute`를 주더라도 `ALLOW_TEST_DATA_DELETE=true`가 없으면 DB·Redis 연결 전에 거부되는 것을 확인했다. 이 단계에서는 실제 cleanup 삭제를 실행하지 않았다. 통합 환경 자체는 tmpfs를 사용했으며 실행 종료 후 전용 컨테이너와 network가 제거된 것을 확인했다.

## 보존 정책과 한계

Git에는 작은 최종 metadata, fixture manifest, summary, audit, metrics, report와 checksum을 보존한다. raw 시계열, CSV/NDJSON, 임시 파일과 dashboard는 `.gitignore`에서 제외한다.

이번 Run은 최소 Smoke이므로 지속 부하, 처리량 한계, retry 내구성이나 운영 환경 성능에 대한 근거로 사용하지 않는다.
