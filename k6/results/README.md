# k6 실행 및 결과 정책

공통 runner는 외부 네트워크 없이 inspect할 수 있으며, 실제 요청은 전용 일회성 로컬 앱·PostgreSQL·Redis의 identity를 모두 확인한 뒤에만 보낸다. 현재 기본 Compose는 일반 `fast_pass` DB와 지속 볼륨을 사용하므로 그 자체로는 실제 실행 자격이 없다.

## 실행 방법

안전하게 해석된 설정만 확인할 때는 다음 명령을 사용한다.

```bash
k6/run.sh --dry-run
```

이 명령은 네트워크 요청이나 결과 디렉터리 생성을 하지 않는다. 실제 실행은 동일한 필수 환경변수를 설정한 뒤 `k6/run.sh`로 시작한다. `SCENARIO`은 `smoke`, `consistency-one-seat`, `consistency-inventory`, `rebooking` 중 하나이며 검증된 정확한 script만 선택한다.

5단계 구현과 축소 통합 실행 근거는 [5단계 검증 기록](../../docs/performance/PHASE5_VERIFICATION.md)에 별도로 보관한다.

6단계 재예약 schema, migration과 격리 통합 실행 근거는 [6단계 검증 기록](../../docs/performance/PHASE6_VERIFICATION.md)에 별도로 보관한다.

## 예약 결과 분류

k6 공통 분류기는 HTTP status만으로 성공이나 정상 충돌을 결정하지 않는다.

- `accepted`: `201 + RESERVATION_ACCEPTED + PENDING`과 예약 ID·request ID·message가 모두 유효한 경우
- `expected_conflict`: `409 + SEAT_ALREADY_RESERVED`와 일치하는 오류 계약인 경우
- `timeout`: `504 + REQUEST_TIMEOUT` 또는 명시적인 전송 timeout 신호인 경우
- `unexpected_error`: 그 외 모든 응답

빈 body, JSON 파싱 실패, 누락된 request ID, status/code 불일치와 일반 연결 실패는 `unexpected_error`다. Redis·queue·DB·lock 장애는 409 정상 충돌로 집계하지 않는다. 각 예약 요청은 동일한 값을 `X-Request-Id`와 테스트 추적 header에 전달한다.

## 환경변수

| 이름                       | 기본값                    | 실제 실행 규칙                                                                                   |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `BASE_URL`                 | `http://127.0.0.1:3000`   | 루프백 `http`/`https`만 허용한다. 경로·query·credential은 거부한다.                              |
| `RUN_ID`                   | inspect 시 `inspect-only` | 실제 실행에서는 필수다. 3~64자의 영문자·숫자·`.`·`_`·`-`만 허용하며 `..`와 경로 문자를 거부한다. |
| `VU`                       | 시나리오별                | Smoke는 1~5, 정합성 시나리오는 1~1,000이다. inventory 기본값은 1,000이다.                        |
| `RPS`                      | `1`                       | 1~10,000의 정수이며 k6 요청률 상한으로 적용한다.                                                 |
| `DURATION`                 | `5s`                      | 1초~60초다.                                                                                      |
| `USER_COUNT`               | 시나리오별                | 정합성 시나리오에서는 `VU`와 정확히 같아야 한다.                                                 |
| `SEAT_COUNT`               | 시나리오별                | 단일 좌석은 1, inventory는 최대 50이며 `VU`를 정확히 나눠야 한다.                                |
| `CACHE_PROFILE`            | `warm`                    | 정합성 시나리오의 `warm` 또는 `cold` 프로필이다.                                                 |
| `TEST_ENVIRONMENT`         | 없음                      | 정확히 `local-disposable`이어야 한다.                                                            |
| `TEST_ENV_ID`              | 없음                      | 3~64자의 안전한 전용 환경 ID여야 한다.                                                           |
| `TEST_DATABASE_NAME`       | 없음                      | `fast_pass_k6_<환경 ID>` 형식의 실제 전용 DB 이름이어야 한다. 연결 URL은 받거나 기록하지 않는다. |
| `TEST_REDIS_ID`            | 없음                      | 전용 Redis 인스턴스의 안전한 ID여야 한다.                                                        |
| `REDIS_KEY_PREFIX`         | 없음                      | 정확히 `k6:<TEST_ENV_ID>:`여야 한다.                                                             |
| `ALLOW_TEST_DATA_MUTATION` | 없음                      | 실제 실행에는 정확히 `true`가 필요하다.                                                          |
| `EXPECTED_APP_ID`          | `fast_pass`               | health 응답의 앱 identity와 일치해야 한다.                                                       |
| `EXPECTED_BUILD_SHA`       | 없음                      | 실제 실행에는 40자리 소문자 Git SHA가 필요하다.                                                  |
| `EXPECTED_MIGRATION_ID`    | 없음                      | 실제 적용된 최신 Prisma migration과 일치해야 한다.                                               |
| `EXPECTED_DB_TLS_MODE`     | `disable`                 | `disable` 또는 `require`이며 실제 PostgreSQL 세션과 일치해야 한다.                               |
| `EXPECTED_REDIS_TLS_MODE`  | `disable`                 | `disable` 또는 `require`이며 실제 Redis client mode와 일치해야 한다.                             |
| `TEST_PREFLIGHT_TOKEN`     | 없음                      | 32~256자의 출력 가능한 ASCII여야 한다. 요청 header에만 사용하고 출력·artifact에 저장하지 않는다. |
| `ALLOW_REMOTE_LOAD`        | 없음                      | `true`여도 2단계에서는 원격 실행이 항상 차단된다.                                                |
| `REMOTE_APPROVAL_MANIFEST` | 없음                      | 12단계 승인 검증기의 예약 인터페이스다. 지금은 원격 실행을 허용하지 않는다.                      |

`--dry-run`은 위 항목 중 비밀이 아닌 최종 해석값만 JSON으로 출력한다. DB/Redis URL, token, password, JWT/AWS secret은 출력하거나 보관하지 않는다.

## Fail-closed preflight

실제 실행 직전에 다음 조건을 모두 검사한다.

1. Compose가 참조하는 `Dockerfile.dev`, `prometheus.yml`이 실제 일반 파일이며 symlink가 아니다.
2. 대상은 루프백이고 `/health/test-environment`가 활성화되어 있다.
3. endpoint는 production에서 항상 숨겨지고, 최소 32자 token의 constant-time 검증을 통과해야 한다.
4. 앱 ID, build SHA, `TEST_ENV_ID`가 기대값과 정확히 일치한다.
5. PostgreSQL에 실제 query를 수행해 DB 이름, 최신 완료 migration, 현재 세션 TLS mode를 확인한다.
6. Redis에 실제 `PING`과 `<REDIS_KEY_PREFIX>environment` marker 조회를 수행해 Redis ID, 환경 ID, prefix, client TLS mode를 확인한다.

하나라도 불일치하거나 응답이 없으면 fixture 생성 전에 종료한다. localhost API가 공유·원격 DB/Redis에 연결된 경우도 통과할 수 없다.

앱의 health endpoint를 사용하려면 비운영 앱 프로세스에 `ENABLE_TEST_PREFLIGHT=true`, 동일한 테스트 환경 식별값, `ALLOW_TEST_DATA_MUTATION=true`를 명시해야 한다. Redis marker는 다음 의미의 JSON이어야 하지만 실제 값은 해당 일회성 환경 프로비저닝 과정에서만 주입한다.

```json
{
  "testEnvId": "<TEST_ENV_ID>",
  "redisId": "<TEST_REDIS_ID>",
  "keyPrefix": "k6:<TEST_ENV_ID>:"
}
```

## No-clobber와 artifact 봉인

모든 결과는 `k6/results/<RUN_ID>/` 바로 아래에만 저장한다. results root나 Run ID 경로가 symlink이거나 경로가 이미 존재하면 실행을 거부한다. 디렉터리 선점은 `mkdir`로 원자적으로 수행한다.

시작 metadata는 다음 상태를 서로 독립적으로 기록한다.

- `execution=RUNNING`
- `artifactSet=OPEN`
- `preflight=PENDING`

앱·DB·Redis 검증을 모두 통과하면 `preflight=VERIFIED`로 전환한다. k6는 먼저 `.summary.json.tmp`에 allowlist metric만 기록한다. Runner가 summary와 사후 감사 artifact의 schema·Run ID를 검사하고, 금지된 secret field·연결 문자열·Bearer 값을 탐지한 다음 각 파일과 `checksums.sha256`을 원자적으로 쓴다. preflight가 검증되지 않았거나 필수 artifact가 빠진 Run은 봉인할 수 없으며, 최종 `metadata.json`을 마지막에 교체한 뒤에만 `artifactSet=FINALIZED`가 된다.

정상 실행은 `execution=COMPLETED`, threshold·k6·감사 실패는 `execution=FAILED`가 될 수 있다. 필수 실패 정보까지 모두 검증 가능한 실패 실행은 봉인할 수 있다. preflight 실패, 중단, schema·checksum 검증 실패는 `artifactSet=INCOMPLETE`로 남고 `FINALIZED`로 승격되지 않는다.

최종 artifact는 다음 파일만 포함한다.

- `metadata.json`: 안전한 실행 파라미터, Git SHA/dirty 여부, script checksum, 런타임 버전, 상태
- `fixture-manifest.json`: 이 Run이 생성한 사용자·이벤트·공연·좌석·요청·예약 ID와 수량
- `summary.json`: allowlist metric과 threshold 결과
- `consistency-audit.json`: queue drain, worker counter, DB 분포, accepted/processed/persisted ID 집합 대조와 판정
- `server-metrics.json`: Run 시간창과 앱·DB·Redis 관측 요약. 관측 불가는 사유가 있는 `unavailable`로 기록
- `report.md`: 목표, 조건, 수치, 정합성, 한계와 다음 결정
- `checksums.sha256`: 위 6개 필수 artifact의 SHA-256

원시 HTTP body, access/refresh token, 사용자 password, 환경 token, DB/Redis URL은 저장하지 않는다.

작은 최종 artifact는 재현성과 비교를 위해 Git에 보존한다. `raw-*`, CSV/NDJSON 시계열, 임시 파일과 `dashboard.html`은 용량 증가와 민감정보 혼입을 막기 위해 `.gitignore`에서 제외한다.

## 사후 감사와 cleanup

Smoke producer가 종료 상태를 기록한 뒤 감사 도구가 pending, processing, retry, DLQ, worker in-flight를 polling한다. 모두 최종 상태가 되고 같은 signature가 안정화 구간 동안 유지되어야 drain으로 인정한다. 그 다음 accepted reservation ID, worker 처리 ID와 해당 performance의 DB Reservation ID 집합을 정확히 비교한다. 건수만 같고 ID가 다르거나 in-flight/DLQ가 남으면 실패다.

cleanup은 봉인된 artifact를 checksum으로 다시 검증한 뒤 실행한다. 기본 명령은 `node k6/tools/cleanup.mjs --dry-run`이며 정확한 Run·환경·manifest ID와 전용 Redis key만 출력한다. 실제 삭제에는 별도로 `--execute`와 `ALLOW_TEST_DATA_DELETE=true`가 모두 필요하다. wildcard, truncate, DB reset과 공유 key 삭제는 금지된다. 3단계 검증에서는 실제 cleanup 삭제를 실행하지 않는다.

## 검증 등급

- 외부 네트워크 없는 단위 테스트, build, k6 inspect, Compose 해석만 성공한 상태: `STATIC_VERIFIED`
- 전용 일회성 앱·DB·Redis preflight, 실제 Smoke, artifact finalize까지 성공한 상태: `INTEGRATION_VERIFIED`

일반 DB 이름과 지속 볼륨을 사용하는 현재 기본 Compose는 의도적으로 preflight에서 차단되므로 `INTEGRATION_VERIFIED`의 근거가 될 수 없다.

전용 로컬 통합 환경은 `k6/tools/run-local-integration.sh`로 실행한다. 이 실행기는 저장된 로컬 이미지로만 `docker-compose.k6.yaml`을 시작하고 PostgreSQL·Redis 데이터 경로에 tmpfs를 사용한다. 서비스 포트는 루프백에만 임시 할당하고 비밀번호·JWT secret·preflight token을 매번 메모리에서 생성한다. migration과 Redis 환경 marker를 초기화하고 Smoke 및 checksum 검증을 마치면 전용 컨테이너·네트워크·임시 로그를 종료·삭제한다.

## 7단계 Redis Streams 검증 기록

2026-10-07에 Redis capability 및 legacy queue readiness 가드를 추가한 clean commit `945be053e2a55208cf6a30cca723871d63a8796d`에서 `local-smoke-20261007065239-89449` Run을 실행했다. metadata의 `gitDirty=false`를 확인했고, `execution=COMPLETED`, `artifactSet=FINALIZED`, `preflight=VERIFIED`, consistency audit `PASS`로 종료됐다.

- accepted / processed / DB persisted: `1 / 1 / 1` (동일 reservation ID)
- pending / processing / retry / DLQ: `0 / 0 / 0 / 0`
- worker in-flight / conservation difference: `0 / 0`
- drain: `1,115ms`
- 상세 결과: [`local-smoke-20261007065239-89449`](./local-smoke-20261007065239-89449/)
- 큐 장애 주입 판정: [`QUEUE_DURABILITY.md`](../../docs/performance/QUEUE_DURABILITY.md)

### 이전 검증 이력

2026-10-05에 Redis Streams consumer group, `XAUTOCLAIM`, reservation ID idempotency를 적용한 뒤 `local-smoke-20261005103558-41063` Run을 실행했다. 이 Run은 `execution=COMPLETED`, `artifactSet=FINALIZED`, `preflight=VERIFIED`이며 consistency audit가 `PASS`다.

- accepted / processed / DB persisted: `1 / 1 / 1` (동일 reservation ID)
- pending / processing / retry / DLQ: `0 / 0 / 0 / 0`
- worker in-flight / conservation difference: `0 / 0`
- drain: `1,089ms`
- 상세 결과: [`local-smoke-20261005103558-41063`](./local-smoke-20261005103558-41063/)
- 큐 장애 주입 판정: [`QUEUE_DURABILITY.md`](../../docs/performance/QUEUE_DURABILITY.md)
