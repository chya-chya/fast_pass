# 2단계 검증 기록

## 판정

- 실행일: 2026-10-01
- 최종 상태: `INTEGRATION_VERIFIED`
- Run ID: `local-smoke-20261001065337-32010`
- 기준 Git SHA: `9bac7e71a383de859a7c6bb2cdae966a7034c66b`
- Working tree: dirty
- 실행 build content SHA: `3edd37fa23a6114f7aa2136760f7a16d0a1feec0`

이 판정은 전용 일회성 로컬 앱·PostgreSQL·Redis의 identity와 실제 연결을 확인한 최소 Smoke 결과다. 처리량이나 운영 환경 성능을 입증하지 않는다.

## 정적 검증

다음 검사를 모두 통과했다.

- Node 단위 테스트 18개
- test health endpoint Jest 테스트 2개
- Nest 애플리케이션 build
- k6 1.4.2 실행 요구사항 inspect
- 기본·production·monitoring·k6 Compose 구성 해석
- Compose bind source 존재 여부
- runner dry-run과 shell/Node 구문 검사
- `git diff --check`

## 격리 환경

[`docker-compose.k6.yaml`](../../docker-compose.k6.yaml)로 로컬에 저장된 PostgreSQL 15·Redis 7 이미지만 사용했다. DB와 Redis 데이터 경로는 tmpfs였고 임시 포트는 루프백에만 공개했다. 비밀번호, JWT secret, preflight token은 실행 시 생성해 프로세스 환경에만 전달했다.

preflight에서 다음 항목을 실제 연결과 대조했다.

- 앱 ID와 build content SHA
- 전용 `TEST_ENV_ID`
- PostgreSQL 연결, 전용 DB 이름, 최신 migration `20260105075934`, TLS mode
- Redis `PING`, 전용 Redis ID, 환경 marker, key prefix, TLS mode
- 필수 bind source

## Smoke 결과

1 VU, 1 RPS, 1 iteration, 5초 제한으로 실행했다.

| 항목              |     결과 |
| ----------------- | -------: |
| Check             | 1/1 통과 |
| 예약 접수         |        1 |
| Unexpected error  |        0 |
| Timeout           |        0 |
| HTTP failure rate |        0 |
| Threshold         |     통과 |

최종 상태는 `execution=COMPLETED`, `preflight=VERIFIED`, `artifactSet=FINALIZED`다. metadata와 summary의 SHA-256도 별도로 재검증했다.

## 증거

- [Metadata](../../k6/results/local-smoke-20261001065337-32010/metadata.json)
- [Summary](../../k6/results/local-smoke-20261001065337-32010/summary.json)
- [Checksums](../../k6/results/local-smoke-20261001065337-32010/checksums.sha256)
- [통합 실행기](../../k6/tools/run-local-integration.sh)

artifact에는 token, password, JWT secret, DB/Redis 연결 문자열이나 원시 HTTP body가 없다.

## 정리 확인

실행 종료 후 전용 컨테이너·Docker network·volume과 임시 애플리케이션 로그가 남지 않은 것을 확인했다. 보존한 항목은 위의 검증 artifact뿐이다.
