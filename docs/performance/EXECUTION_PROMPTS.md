# FastPass 단계별 실행 프롬프트

## 사용 방법

이 문서의 프롬프트를 위에서부터 한 단계씩 별도 작업으로 실행한다. 각 단계가 끝나면 완료 조건과 변경 내용을 검토한 뒤 다음 프롬프트로 넘어간다.

- 작업 시작 시 `git rev-parse --show-toplevel`로 저장소 루트를 확인하고, 특정 사용자의 절대 경로를 문서나 스크립트에 기록하지 않는다.
- 각 작업을 시작할 때 `docs/performance/CHANGE_PLAN.md`와 이전 단계 결과를 먼저 읽는다.
- 사용자 변경 사항과 관련 없는 파일을 수정하지 않는다.
- 결과 artifact의 유일한 기준 경로는 `k6/results/<run-id>/`이다. `docs/performance/results` 등 다른 결과 루트를 새로 만들지 않는다.
- 실제 원격 부하는 12단계에서만 수행하며, 정확한 대상과 한도·만료 시각이 담긴 승인 manifest를 사용자가 명시적으로 승인하기 전에는 실행하지 않는다.
- 실제 측정값이 없는 상태에서 README나 포트폴리오에 새로운 성능 수치를 작성하지 않는다.
- 한 단계가 실패하면 실패를 숨기지 말고 원인, 재현 방법, 다음 결정 사항을 문서화한다.
- 문서 또는 코드에 적힌 URL과 기본 환경변수는 신뢰하지 말고 실제 값을 먼저 검사한다. 검사 결과에 비밀값 자체를 출력하지 않는다.
- 테스트 실행은 전용 DB·Redis와 삭제 가능한 fixture를 사용하는 일회성 격리 환경에서만 허용한다. 환경 정체성이 불명확하거나 공유·운영 자원일 가능성이 있으면 fail-closed로 중단한다.
- 각 완료 Gate는 `STATIC_VERIFIED`, `INTEGRATION_VERIFIED`, `REMOTE_VERIFIED` 중 실제로 달성한 수준을 표시한다. 정적 검사나 sample artifact만으로 통합 실행 성공을 주장하지 않는다.
- 실행 상태와 artifact 봉인 상태를 구분한다. 실행은 `PENDING/RUNNING/COMPLETED/FAILED/ABORTED`, artifact set은 `OPEN/FINALIZED/INCOMPLETE`를 사용한다. 모든 생성 파일의 원자적 쓰기, schema·비밀·checksum 검사가 끝난 뒤에만 artifact set을 `FINALIZED`로 전환한다. 실패한 실행도 실패 보고서를 포함해 검증 가능한 상태로 봉인할 수 있으며, 기존 Run ID가 있으면 덮어쓰지 않고 실패한다.
- Jest나 통합 테스트를 실행하기 전에 `.env` 또는 기본 localhost를 통해 영속 DB·Redis에 연결하는 테스트인지 확인한다. 전용 일회성 환경임을 입증하지 못하면 네트워크 통합 테스트를 실행하지 않고 unit/mock 검증만 수행한다.

### Gate 상태 정의

- `STATIC_VERIFIED`: build, 단위 테스트, `k6 inspect`, 설정 검증까지만 통과했다. 실제 앱·DB·Redis 경로는 검증하지 않았다.
- `INTEGRATION_VERIFIED`: 격리된 로컬/테스트 앱·DB·Redis에서 축소 실행과 ID 단위 사후 감사까지 통과했다.
- `REMOTE_VERIFIED`: 승인 manifest 범위의 격리 원격 환경에서 실행·중단 감시·사후 감사·안전한 cleanup까지 통과했다.
- 상위 상태는 하위 상태를 포함한다. 필요한 수준에 못 미치면 `BLOCKED` 또는 `FAILED`로 기록하고 다음 의존 단계로 넘어가지 않는다.

### Codex 추론 수준 사용법

아래 권장값은 각 단계를 **새 작업으로 시작할 때 선택할 reasoning effort**다. 프롬프트 본문에 수준을 적는 것만으로 설정이 바뀌지는 않는다. 지원 수준은 모델마다 다르므로 선택한 모델에서 제공하는 값을 확인한다.

- `medium`: 범위가 명확한 구현과 검증에 사용하는 기본 균형값
- `high`: 저장소 전반의 분석, 여러 파일 변경, 복합 판정과 안전 검토가 필요한 작업
- `xhigh`: 동시성·데이터 모델·장애 복구처럼 오판 비용이 크거나 승인된 원격 실행을 다루는 작업

높은 수준일수록 일반적으로 더 많은 시간과 토큰을 사용할 수 있다. `xhigh`는 해당 단계의 위험과 복잡성 때문에 지정한 것이며, 사용자 승인이나 완료 Gate를 대신하지 않는다. `xhigh`를 지원하지 않는 모델에서는 `high`를 사용하고 검토 작업을 별도 단계로 추가한다. `max`는 대표 작업 평가에서 명확한 이점이 확인된 경우에만 고려하므로 기본 권장값에서 제외한다. 기준은 [OpenAI reasoning effort 안내](https://developers.openai.com/api/docs/guides/reasoning)를 따른다.

| 단계 | 권장 수준 | 선정 이유 |
| --- | --- | --- |
| 0 | `high` | 저장소 전체의 원격 진입점을 찾아 fail-closed 안전장치를 적용해야 한다. |
| 1 | `high` | 코드·문서·과거 주장 사이의 모순과 증거 수준을 판정해야 한다. |
| 2 | `high` | 공통 runner, 격리 환경 확인과 no-clobber를 여러 파일에 일관되게 구현해야 한다. |
| 3 | `xhigh` | 산출물 생명주기, ID 감사와 삭제 방지 cleanup을 결합한 고위험 다중 시스템 작업이다. |
| 4 | `high` | 공개 API 호환성을 지키면서 정상 충돌과 시스템 장애 계약을 구분해야 한다. |
| 5 | `high` | 분산 실행에서도 결정적인 요청 배정과 사후 정합성 검증을 보장해야 한다. |
| 6 | `high` | 동시성 불변식, 이력 보존, DB schema와 migration의 영향을 함께 판단해야 한다. |
| 7 | `xhigh` | 장애 주입으로 큐 유실·중복·재처리 안전성을 검증하고 `NO_GO`를 결정해야 한다. |
| 8 | `high` | 여러 계층의 지표 의미와 PM2 집계를 같은 시간축으로 연결해야 한다. |
| 9 | `medium` | 앞서 확정한 공통 규칙을 재사용하는 범위가 명확한 VU 시나리오 구현이다. |
| 10 | `high` | arrival-rate 의미, 발생기 포화와 지속 가능 처리량 판정을 정확히 분리해야 한다. |
| 11 | `high` | 장시간·급증 시험의 용량 계산, watchdog와 중단 기준을 함께 설계해야 한다. |
| 12 | `xhigh` | 승인 범위를 검증하면서 실제 원격 부하와 안전한 중단·cleanup을 수행한다. |
| 13 | `high` | 여러 Run의 증거를 대조해 과장 없이 포트폴리오 문장으로 종합해야 한다. |

---

## 0단계 — 레거시 원격 실행 경로 격리

> **권장 Codex 추론 수준:** `high` — 저장소 전체의 실행 경로와 안전장치를 교차 검토한다.

### 실행 프롬프트

```text
FastPass 저장소에서 의도치 않은 원격 부하를 발생시킬 수 있는 기존 실행 경로를 먼저 격리해 줘.

먼저 저장소 루트를 `git rev-parse --show-toplevel`로 확인하고 다음을 읽어라.
- docs/performance/CHANGE_PLAN.md
- docs/performance/EXECUTION_PROMPTS.md
- README.md
- package.json과 실행 스크립트
- k6/load-test.js
- k6/consistency-test.js
- .env.example, config 모듈, docker-compose*.yaml에 선언된 환경변수 이름과 기본값

목표:
1. 하드코딩된 ALB, 공인 IP, 원격 도메인과 원격을 가리키는 BASE_URL 기본값을 모두 찾는다.
2. README의 복사 가능한 k6 명령이 기본적으로 localhost만 향하도록 고친다.
3. 레거시 k6 스크립트를 당장 삭제하지 말고, localhost 외 대상에서는 공통 원격 승인 guard 없이는 시작조차 못 하도록 fail-closed 처리한다.
4. URL 문자열만 검사하지 말고 DNS 이름, 환경 이름, 명시적 `TEST_ENV_ID`, 전용 DB/Redis 식별자를 함께 확인할 수 있는 기반을 정한다.
5. 환경변수의 이름·기본값·필수 여부를 표로 남기되 `.env`의 실제 비밀값은 출력하거나 artifact에 저장하지 않는다.
6. `k6 inspect`와 정적 검색만 수행하고 HTTP 요청, DNS 확인, 원격 연결, DB/Redis 연결은 하지 않는다.
7. `k6/results/README.md`가 아직 없다면 결과 루트 정책, no-clobber, execution 상태와 artifactSet `OPEN/FINALIZED/INCOMPLETE` 규칙의 초안을 만든다.

제약:
- 이 단계에서는 부하 테스트를 실행하지 마라.
- 원격 URL이 발견돼도 연결 가능 여부를 확인하지 마라.
- 레거시 결과나 사용자 파일을 삭제·덮어쓰지 마라.
- 특정 사용자의 절대 경로를 새로 기록하지 마라.

검증:
- git diff --check
- 새 기본값과 README 명령에 외부 호스트가 없는지 정적 검색
- 레거시와 새 k6 진입점이 localhost 외 대상에서 승인 guard를 요구하는지 단위 또는 정적 테스트
- 네트워크 없이 가능한 모든 k6 파일의 inspect

완료 보고:
- 발견한 원격 실행 경로
- 바꾼 기본값과 guard
- 검사한 환경변수와 안전하지 않은 fallback
- 수행하지 않은 네트워크 작업
- 달성한 Gate 상태
를 요약하라.
```

### 완료 Gate

- README와 모든 기존 k6 진입점이 기본 실행만으로 원격 요청을 보낼 수 없다.
- 환경 정체성이 없으면 실행을 거부하는 fail-closed 기반이 있다.
- 최소 `STATIC_VERIFIED`이며, 이 단계에서는 `INTEGRATION_VERIFIED`를 주장하지 않는다.

---

## 1단계 — 현재 주장과 증거 감사

> **권장 Codex 추론 수준:** `high` — 코드·문서·증거의 모순과 신뢰도를 판정한다.

### 실행 프롬프트

```text
FastPass 저장소의 성능·동시성 관련 주장과 실제 증거를 감사해 줘.

먼저 다음 파일을 읽어라.
- docs/performance/CHANGE_PLAN.md
- README.md
- RETROSPECTIVE.md
- portfolio/*.md
- work_logs/*.md
- k6/load-test.js
- k6/consistency-test.js
- src/reservation/*
- prisma/schema.prisma
- docker-compose*.yaml
- prometheus.yml.template
- src/tracing.ts

목표:
1. 현재 문서에 기록된 VU, RPS, latency, 정합성, DB Read 감소 등 모든 수치를 찾는다.
2. 각 주장에 대해 근거 파일, 테스트 조건, 재현 가능 여부, 현재 코드와의 일치 여부를 확인한다.
3. 3,000 VU와 3,000 RPS가 혼용된 부분, 201과 DB 영속화가 혼용된 부분, 500 VU와 1,000 VU 시나리오가 혼용된 부분을 명확히 표시한다.
4. 실행할 수 없는 명령이나 오래된 아키텍처 설명도 찾는다.
5. 결과를 docs/performance/CURRENT_STATE.md에 표로 작성한다.
6. `.gitignore`, `git check-ignore -v`, `git ls-files`를 이용해 성능 문서·`portfolio/`·`work_logs/`·`k6/results/`의 추적 상태를 확인한다.
7. 개선 전 기준선 후보 Git SHA와 재현에 필요한 이미지·migration·환경 설정이 남아 있는지 확인한다. 기준선 후보를 추측해서 확정하지 않는다.
8. BASE_URL, DB, Redis, 인증 TTL, queue 관련 환경변수의 코드상 기본값을 검사하고 원격·공유 자원을 암묵적으로 선택하는 fallback을 표시한다. 실제 비밀값은 출력하지 않는다.

CURRENT_STATE.md의 표에는 다음 열을 포함하라.
- 주장
- 현재 출처
- 실제 코드/실험 조건
- 검증 상태: verified / historical / unsupported / contradicted
- 위험
- 필요한 재검증

추가로 다음을 별도 절에 기록하라.
- Git 추적/ignore 상태와 별도 작업공간에서 사라질 파일
- 비교 가능한 변경 전 기준선 후보와 미확정 항목
- 위험한 환경변수 기본값과 fail-closed 전환 필요 여부

제약:
- 이 단계에서는 런타임 코드, k6 스크립트, README, RETROSPECTIVE를 수정하지 마라.
- 원격 API나 AWS 환경에 요청을 보내지 마라.
- 추측으로 수치를 채우지 마라.
- 사용자 변경 사항이 있으면 보존하라.

검증:
- git diff --check
- 문서에 등장하는 모든 수치가 감사 표에 포함됐는지 rg로 대조
- CURRENT_STATE.md의 내부 링크가 실제 파일을 가리키는지 확인
- 성능 문서와 포트폴리오 대상 파일의 추적/ignore 상태 확인

완료 보고:
- 새로 만든 파일
- verified, historical, unsupported, contradicted 항목 수
- 즉시 제거하거나 보류해야 할 주장
- 다음 단계에 영향을 주는 위험
- 기준선 후보와 파일 추적 위험
을 요약하라.
```

### 완료 Gate

- 모든 기존 성능 수치가 출처와 검증 상태를 가진다.
- `3,000 RPS`, `2,000 VU`, `정합성 100%`, `DB Read 90% 감소`의 상태가 명시된다.
- 비교 가능한 기준선 후보와 포트폴리오 파일의 Git 추적 상태가 명시된다.
- 코드 변경 없이 감사 문서만 생성된다.

---

## 2단계 — k6 공통 기반과 Smoke Test 구축

> **권장 Codex 추론 수준:** `high` — 공통 기반과 환경 격리·실행 안전성을 함께 구현한다.

### 실행 프롬프트

```text
FastPass의 새 k6 테스트 공통 기반과 로컬 Smoke Test를 구현해 줘.

먼저 다음 문서를 읽어라.
- docs/performance/CHANGE_PLAN.md
- docs/performance/CURRENT_STATE.md

현재 k6/load-test.js와 k6/consistency-test.js는 새 구조가 검증될 때까지 삭제하지 마라.

목표 구조:
- k6/lib/config.js
- k6/lib/api.js
- k6/lib/metrics.js
- k6/lib/summary.js
- k6/scenarios/smoke.js
- k6/run.sh
- k6/results/README.md

구현 요구사항:
1. BASE_URL, RUN_ID, VU, RPS, duration, 사용자 수, 좌석 수를 환경변수로 받는다.
2. BASE_URL 기본값은 localhost로 하고 원격 URL은 명시적인 환경변수와 ALLOW_REMOTE_LOAD=true 없이는 실행하지 못하게 한다.
3. Run ID와 숫자 환경변수를 시작 시 검증하고 잘못된 값은 fail-fast 처리한다. Run ID는 길이가 제한된 영문자·숫자·`.`·`_`·`-`만 허용하고 `/`, `\\`, `..`, 제어문자, symlink 경로를 거부하며 최종 경로가 `k6/results/` 아래인지 확인한다.
4. 기존 jslib.k6.io 난수 import를 제거하고 네트워크 없이 k6 inspect가 가능하게 한다.
5. signup, login, event, performance, seat 조회 공통 호출을 api.js로 분리한다.
6. Setup의 모든 상태 코드와 필수 JSON 필드를 검증하고 실패하면 본 실행을 중단한다.
7. accepted, expected_conflict, unexpected_error, timeout을 별도 지표로 정의한다.
8. endpoint, scenario, outcome 태그를 사용한다.
9. 토큰, 비밀번호, JWT secret, DATABASE_URL을 로그나 결과 파일에 쓰지 않는다.
10. Smoke Test는 1~5 VU의 최소 요청으로 Fixture와 결과 저장 연결만 확인한다.
11. Runner는 `k6/results/<run-id>/`가 이미 존재하면 덮어쓰지 않고 실패한다. 임시 파일에 쓴 뒤 원자적으로 rename한다. 시작 시 execution=`RUNNING`, artifactSet=`OPEN`으로 기록하고 실행 종료 상태와 별개로 artifact 검증 완료 뒤에만 artifactSet=`FINALIZED`로 봉인한다.
12. `TEST_ENV_ID`, `ALLOW_TEST_DATA_MUTATION`, 전용 DB 이름/prefix, Redis key prefix를 검사한다. 전용 일회성 환경임을 입증하지 못하면 fixture 생성·테스트·cleanup을 모두 거부한다.
13. 환경변수별 기본값과 최종 해석값 중 비밀이 아닌 항목만 `--dry-run` 또는 inspect 모드에서 볼 수 있게 한다. DB/Redis URL은 host를 포함한 원문 대신 안전한 환경 식별자만 표시한다.
14. `ALLOW_REMOTE_LOAD=true`는 충분한 승인이 아니다. 이 단계에서는 원격 실행을 계속 막고, 12단계에서 승인 manifest 검증을 추가할 수 있는 인터페이스만 정의한다.
15. `docker compose config` 성공을 런타임 준비 완료로 간주하지 않는다. disposable 환경에서 FastPass 앱 identity와 build SHA, migration 상태, DB·Redis 실제 연결과 TLS mode, 필요한 bind mount 파일, health endpoint를 확인하는 preflight를 구현한다. 현재 구성의 `db` hostname SSL 판정, standalone Redis TLS, 누락된 Prometheus 설정 파일 같은 문제가 재현되면 숨기지 말고 최소 범위로 수정하거나 `BLOCKED`로 기록한다.

제약:
- 원격 환경에는 어떤 요청도 보내지 마라.
- 로컬 서버가 실행 중인지 확인되지 않으면 k6 run은 생략하고 inspect까지만 수행하라.
- package.json의 기존 lint script는 --fix를 포함하므로 읽기 전용 검증 용도로 실행하지 마라.
- 기존 스크립트의 동작을 몰래 바꾸지 마라.
- 공유 개발 DB/Redis나 운영 환경을 로컬로 간주하지 마라. `localhost` API가 원격 DB/Redis를 사용하는 구성도 거부한다.

필수 검증:
- git diff --check
- npm run build
- k6 version
- k6 inspect --execution-requirements k6/scenarios/smoke.js
- docker compose config --quiet
- 필요한 bind mount 원본 파일의 존재 검사
- disposable 환경이 준비된 경우 앱 identity/build SHA와 DB·Redis 연결 health 확인

로컬 API와 그 뒤의 DB·Redis가 전용 일회성 환경임을 preflight로 확인한 경우에만 다음 수준의 Smoke Test를 실행하라.
- BASE_URL=http://127.0.0.1:3000
- TEST_ENV_ID=<확인된-격리환경-id>
- ALLOW_TEST_DATA_MUTATION=true
- RUN_ID=local-smoke-<timestamp>
- 최소 VU와 짧은 duration

완료 보고:
- 변경 파일
- 환경변수 목록과 기본값
- 원격 실행 차단 방식
- no-clobber와 실행 상태/artifact finalize 방식
- 테스트 환경 식별과 fail-closed 조건
- 수행한 검증과 결과
- 로컬 Smoke Test를 생략했다면 그 이유
를 적어라.
```

### 완료 Gate

- 외부 네트워크 없이 모든 새 k6 파일을 inspect할 수 있다.
- 하드코딩된 ALB URL과 비밀값이 새 코드에 없다.
- 정적 검증만 성공하면 `STATIC_VERIFIED`로 기록한다.
- 앱·전용 DB·전용 Redis를 실제로 통과한 Smoke와 artifact finalize까지 성공한 경우에만 `INTEGRATION_VERIFIED`로 기록한다.

---

## 3단계 — 결과 저장과 사후 정합성 감사 구축

> **권장 Codex 추론 수준:** `xhigh` — 산출물 상태, ID 감사와 삭제 방지 cleanup을 함께 설계한다.

### 실행 프롬프트

```text
FastPass k6 실행 결과와 사후 정합성 감사 결과를 Run ID별로 저장하는 기능을 구현해 줘.

먼저 다음을 읽어라.
- docs/performance/CHANGE_PLAN.md
- docs/performance/CURRENT_STATE.md
- 2단계에서 생성된 k6/lib/*, runner, smoke 시나리오
- src/reservation/reservation.service.ts
- src/reservation/reservation.scheduler.ts
- prisma/schema.prisma
- src/prisma/prisma.service.ts

목표 산출물:
k6/results/<run-id>/
- metadata.json
- fixture-manifest.json
- summary.json
- consistency-audit.json
- server-metrics.json
- report.md
- 선택적 dashboard.html

구현 요구사항:
1. handleSummary()를 이용해 집계 지표와 threshold 통과 여부를 summary.json에 저장한다.
2. runner가 Git SHA, k6/Node 버전, 테스트 스크립트 checksum, 시작·종료 시각, executor와 입력 파라미터를 metadata.json에 기록한다.
3. metadata에는 비밀값과 전체 connection string을 절대 기록하지 않는다.
   - fixture-manifest.json에는 이 Run이 만든 사용자·이벤트·공연·좌석·예약의 식별자와 수량만 기록하고 토큰·비밀번호는 기록하지 않는다.
   - server-metrics.json에는 Run 시간창과 앱·DB·Redis 지표의 요약 및 원본 관측 링크만 기록한다. 관측할 수 없으면 빈 성공값 대신 `unavailable`과 사유를 기록한다.
4. performanceId와 명시적인 test run 식별자를 기준으로 사후 DB 감사를 수행한다. 다른 Run이나 기존 데이터가 섞이지 않도록 모든 fixture와 요청에 추적 가능한 저카디널리티 Run 경계를 둔다.
5. 감사 도구는 producer 종료를 먼저 확인하고 Redis 대기 queue뿐 아니라 processing/in-flight, retry, DLQ와 worker 처리 중 counter를 함께 polling한다. 모든 값이 0 또는 정의된 최종 상태가 된 뒤 안정화 구간 동안 변하지 않을 때만 drain 완료로 본다.
6. 다음 값을 consistency-audit.json에 기록한다.
   - accepted 응답 수
   - Redis queue, processing/in-flight, retry, DLQ의 최종 길이와 drain 시간
   - DB Reservation 총수
   - distinct seatId 수
   - 좌석별 중복 수
   - Seat 상태 분포
   - Reservation 상태 분포
   - enqueue, 처리 성공, 재시도, 최종 실패/DLQ counter와 보존 법칙 차이
   - accepted request/reservation ID 집합과 DB 영속화 ID 집합의 누락·초과·중복 목록. 대규모 Run은 정렬·압축한 ID manifest의 URI·SHA-256·건수와 불일치 표본을 기록한다.
   - 최종 pass/fail과 실패 사유
7. 단순 건수뿐 아니라 ID 집합이 정확히 일치해야 한다. `accepted = persisted`여도 ID가 다르거나 in-flight가 남으면 실패로 표시하고 성공 보고서를 만들지 않는다.
8. report.md에는 목표, 조건, 핵심 수치, 정합성 결과, 한계, 다음 결정을 포함한다.
9. .gitignore에는 큰 raw timeseries와 임시 dashboard를 무시하는 정책을 추가하되, 작은 metadata/summary/audit/report의 보존 정책을 k6/results/README.md에 설명한다.
10. 결과 디렉터리에 accessToken, refreshToken, password, JWT_SECRET, DATABASE_URL이 포함되지 않도록 검사한다.
11. artifact는 Run 시작 전 no-clobber 확인, 파일별 임시 쓰기와 원자적 rename, checksum 생성, 최종 schema/비밀 검사 순으로 저장한다. 실행이 실패하면 execution=`FAILED` 또는 `ABORTED`로 남긴다. 실패 보고서를 포함한 생성 가능 artifact가 완전하면 artifactSet=`FINALIZED`, 필수 실패 정보조차 봉인하지 못하면 `INCOMPLETE`로 기록한다.
12. cleanup은 별도 명령으로 구현하고 기본은 dry-run으로 한다. `TEST_ENV_ID`, 정확한 Run ID, 생성 ID manifest, 전용 prefix, `ALLOW_TEST_DATA_DELETE=true`를 모두 확인한 뒤 해당 ID만 삭제한다. wildcard, 전체 테이블 truncate, DB reset, 공유 key 삭제는 금지한다.

감사 구현은 테스트 환경에서만 DB와 Redis를 읽도록 한다. 테스트 환경 정체성이 불명확하거나 Run 경계를 입증할 수 없으면 감사와 cleanup을 fail-closed로 중단한다. cleanup은 별도 명시적 명령으로 분리하고, 구현하더라도 이 단계에서 실제 삭제는 수행하지 마라.

검증:
- git diff --check
- npm run build
- 관련 Jest 테스트
- k6 inspect --execution-requirements k6/scenarios/smoke.js
- 생성한 fixture/sample JSON에 대해 jq empty
- 결과 디렉터리에 비밀 패턴이 없는지 rg로 확인
- sample artifact에 대해 no-clobber, 중간 실패, checksum 불일치, finalize 거부 테스트
- cleanup dry-run이 정확한 생성 ID만 열거하고 환경 guard 실패 시 삭제하지 않는 테스트

실제 DB나 Redis가 준비되지 않았다면 감사 로직의 단위 테스트와 sample artifact까지만 만들고, 연결 테스트를 생략한 이유를 보고하라.

완료 보고:
- artifact별 생성 주체
- 감사 알고리즘과 timeout
- in-flight와 ID 집합 대조 방식
- no-clobber/finalize 및 안전한 cleanup 방식
- Git에 보존되는 파일과 제외되는 파일
- 검증 결과
를 요약하라.
```

### 완료 Gate

- 한 Run의 환경·요약·정합성 결과가 같은 Run ID 아래 연결된다.
- 결과 파일에서 비밀정보가 발견되지 않는다.
- DB/Redis가 없어도 감사 로직을 단위 테스트할 수 있지만 상태는 `STATIC_VERIFIED`까지만 부여한다.
- 격리된 실제 DB/Redis에서 queue·in-flight 안정화와 ID 집합 대조가 끝난 경우에만 `INTEGRATION_VERIFIED`로 부여한다.

---

## 4단계 — 구조화된 예약 결과·오류 계약 확정

> **권장 Codex 추론 수준:** `high` — API 호환성과 오류 분류의 정확성을 함께 판단한다.

### 실행 프롬프트

```text
FastPass의 정합성 시나리오가 정상 충돌과 시스템 장애를 확실히 구분할 수 있도록 예약 API 결과 계약을 먼저 확정해 줘.

먼저 다음을 읽어라.
- docs/performance/CHANGE_PLAN.md
- docs/performance/CURRENT_STATE.md
- src/reservation의 controller, service, DTO, exception 처리
- Swagger 설정과 기존 예약 테스트
- k6/lib/api.js와 k6/lib/metrics.js

목표:
1. 예약 성공, 이미 점유된 좌석, 존재하지 않는 좌석, 인증 실패, 입력 오류, Redis/Lua 실패, enqueue 실패, DB/내부 오류를 표로 정의한다.
2. 정상적인 좌석 경합만 명시적인 안정적 error code와 HTTP 409로 분류한다. Redis·queue·DB·timeout은 409로 변환하지 않는다.
3. 응답의 HTTP status, machine-readable code, 안전한 message, request correlation 필드 계약을 DTO/Swagger/테스트에 일치시킨다.
4. k6 공통 분류기가 status만 보지 않고 구조화 code를 검증해 accepted, expected_conflict, unexpected_error, timeout으로 분류하게 한다.
5. 정의되지 않은 응답, JSON 파싱 실패, 빈 body, status/code 불일치는 fail-closed로 unexpected_error가 되게 한다.
6. 내부 오류 내용, Redis key, SQL, stack, 토큰 등은 응답과 artifact에 노출하지 않는다.

제약:
- 오류를 정상 충돌처럼 보이게 만들어 threshold를 통과시키지 마라.
- 기존 공개 API를 바꾸는 경우 호환성 영향과 migration 방법을 보고하라.
- 원격 요청이나 부하 테스트를 실행하지 마라.

검증:
- git diff --check
- npm run build
- 상태/code 조합별 단위·통합 테스트
- Swagger schema와 실제 응답 DTO의 일치 확인
- k6 분류기의 fixture 응답 테스트와 smoke.js inspect

완료 보고:
- 결과 계약 표
- 변경한 HTTP status/error code
- k6 분류 규칙
- 호환성 영향
- 달성한 Gate 상태
를 요약하라.
```

### 완료 Gate

- 정상 충돌과 Redis·queue·DB·timeout 오류가 기계적으로 구분된다.
- 계약 테스트가 실제 앱까지 통과한 경우에만 `INTEGRATION_VERIFIED`로 기록한다.
- 이 Gate가 완료되지 않으면 정합성 시나리오를 구현하거나 실행하지 않는다.

---

## 5단계 — 단일 좌석·50석 정합성 시나리오 구현

> **권장 Codex 추론 수준:** `high` — 분산 실행의 결정성 및 접수·저장 불변식을 검증한다.

### 실행 프롬프트

```text
FastPass의 예약 정합성을 검증하는 재현 가능한 k6 시나리오를 구현해 줘.

먼저 docs/performance/CHANGE_PLAN.md와 0~4단계 결과를 읽어라.

구현 대상:
- k6/scenarios/consistency-one-seat.js
- k6/scenarios/consistency-inventory.js
- 필요한 공통 helper와 테스트

시나리오 A: 단일 좌석 충돌
- 충분한 사용자 또는 사전 발급 토큰을 사용한다.
- 모든 VU가 동일한 좌석을 한 번만 요청한다.
- per-vu-iterations 계열 executor를 사용한다.
- 정확히 1건의 accepted와 나머지 expected conflict를 기대한다.

시나리오 B: 50석 균등 경쟁
- 기본값은 1,000 VU × 1 iteration이다.
- 50개 좌석에 전역 iteration ID % 50 방식으로 정확히 20개 요청씩 배정한다.
- 무작위 좌석 선택을 사용하지 않는다.
- Warm Cache와 Cold Cache를 별도 환경변수 또는 별도 실행 프로필로 구분한다.
- 정확히 50 accepted, 950 expected conflict, unexpected error 0을 기대한다.

공통 요구사항:
1. 201과 409를 단순히 모두 성공 Check로 묶지 말고 별도 Counter/Rate로 기록한다.
2. 모든 409가 나와도 테스트가 통과하지 않게 accepted 정확값을 검증한다.
3. response body 또는 구조화된 오류 코드를 이용해 정상 충돌과 Redis/Queue 오류를 구분한다.
4. setup 데이터 생성은 측정 구간과 분리한다. 1,000명의 회원가입·로그인을 본 부하 시나리오에 섞지 않는다.
5. k6 결과만으로 끝내지 말고 3단계의 queue drain 및 DB 감사와 연결한다.
6. 결과 파일에 performanceId와 데이터셋 조건을 남기되 토큰은 저장하지 않는다.
7. `(__VU - 1) % 50`에 의존하지 않는다. 분산 k6, execution segment, 복수 scenario에서도 충돌하지 않는 `k6/execution`의 전역 iteration 식별자 또는 사전 생성된 immutable 요청 manifest를 사용해 좌석과 사용자를 매핑한다.
8. 단일 프로세스와 분산 실행 모두에서 각 좌석의 정확한 요청 수를 사전 계산하고, 실제 요청 manifest와 사후 집계가 일치하는지 검증한다.

제약:
- 이 단계에서는 원격 부하 테스트를 실행하지 마라.
- 로컬 환경에서 1,000 VU를 자동 실행하지 마라. 소규모 값으로 기능만 확인하고 본 수치는 inspect로 검증하라.
- 서버 오류를 409 정상 충돌로 숨기지 마라.

검증:
- git diff --check
- npm run build
- 관련 Jest 테스트
- 각 시나리오에 대한 k6 inspect --execution-requirements
- 가능하면 로컬에서 축소된 좌석·VU Smoke 실행
- 1,000 VU 프로필이 정확히 VU당 1 iteration인지 inspect 결과로 확인
- 단일·분산 segment 입력에 대한 사용자/좌석 매핑 단위 테스트

완료 보고:
- 분산 실행에도 안전한 사용자/좌석 배정식과 요청 manifest
- 사용자/토큰 준비 방식
- 상태 분류 규칙
- 사후 감사 연결 방식
- 실행하지 않은 원격 테스트
를 요약하라.
```

### 완료 Gate

- 동일 입력에서 좌석별 요청 수가 항상 동일하다.
- 정확한 accepted 수와 DB 영속화 수가 모두 통과 조건에 포함된다.
- 정적 검증만 성공하면 `STATIC_VERIFIED`로 기록한다.
- 축소된 실행이라도 앱·전용 DB·전용 Redis 및 ID 집합 감사까지 통과해야 `INTEGRATION_VERIFIED`로 기록한다.

---

## 6단계 — 취소·만료 후 재예약 회귀 테스트와 수정

> **권장 Codex 추론 수준:** `high` — 동시성 불변식과 DB schema·migration의 영향을 함께 검토한다.

### 실행 프롬프트

```text
FastPass에서 예약 취소 또는 만료 후 같은 좌석을 다시 예약할 수 있는지 테스트 우선 방식으로 검증하고, 확인된 결함만 최소 범위로 수정해 줘.

먼저 다음을 읽어라.
- docs/performance/CHANGE_PLAN.md
- prisma/schema.prisma
- src/reservation/reservation.service.ts
- src/reservation/reservation.scheduler.ts
- 기존 reservation spec과 migration

검증할 흐름:
1. 좌석 최초 예약 접수
2. Redis queue 처리와 DB 영속화 완료
3. 예약 취소 또는 만료
4. Seat가 AVAILABLE로 복구됐는지 확인
5. 동일 좌석 재예약
6. 두 번째 queue 처리
7. 두 번째 예약이 DB에 정상적으로 영속화되는지 확인

구현 대상에는 서버 통합 테스트와 `k6/scenarios/rebooking.js`를 포함한다. `rebooking.js`는 공통 config·API·metric·summary·runner를 재사용하고, 다른 시나리오와 동일한 환경변수 이름, 결과 분류, Run artifact 규칙을 따라야 한다.

작업 순서:
1. 현재 구현에서 문제를 재현하는 통합 테스트를 먼저 추가한다.
2. Reservation.seatId unique와 취소 이력 보존 정책의 충돌을 분석한다.
3. 테스트가 실제로 실패하는 것을 확인한 뒤에만 수정한다.
4. 이력 보존, 활성 예약 중복 방지, Prisma relation, DB migration을 함께 고려해 최소한의 올바른 모델을 선택한다.
5. 데이터 손실 가능성이 있는 migration이나 기존 행 삭제는 수행하지 말고 migration 내용을 명시적으로 보고한다.
6. 최초 예약 동시성 테스트와 취소·확정 기능이 계속 통과하는지 확인한다.
7. `rebooking.js`는 최초 accepted ID와 두 번째 accepted ID를 구분해 기록하고, 3단계 감사가 두 ID의 상태 전이와 DB 이력을 직접 대조하게 한다.

중요:
- 단순히 unique constraint를 제거해 중복 활성 예약이 가능해지게 만들지 마라.
- CANCELLED 이력 여러 건과 PENDING/CONFIRMED 활성 예약의 불변식을 각각 정의하라.
- 스키마 설계 선택이 제품 정책에 따라 달라지고 안전한 기본값을 정할 수 없다면, 구현 전에 선택지와 trade-off를 보고하고 사용자 결정을 기다려라.
- 원격 DB migration은 실행하지 마라.

검증:
- git diff --check
- npm run build
- 관련 단위·통합 테스트
- Prisma schema validation
- 생성된 migration SQL 검토
- k6 inspect --execution-requirements k6/scenarios/rebooking.js
- 격리 환경이 준비된 경우에만 축소된 rebooking 실행과 ID 단위 사후 감사

완료 보고:
- 재현된 실패
- 선택한 데이터 불변식
- 스키마·서비스 변경
- rebooking.js와 공통 runner 일치 여부
- migration 영향
- 테스트 결과
를 요약하라.
```

### 완료 Gate

- 최초 예약과 재예약 모두 최종 DB에 올바르게 반영된다.
- 동시에 두 개의 활성 예약이 같은 좌석을 차지할 수 없다.
- 원격 DB에는 migration이 적용되지 않는다.
- 정적 검증만으로 재예약 성공을 주장하지 않는다. 전용 DB·Redis를 포함한 전체 흐름을 통과해야 `INTEGRATION_VERIFIED`로 기록한다.

---

## 7단계 — 비동기 큐 유실 위험 검증과 설계 Gate

> **권장 Codex 추론 수준:** `xhigh` — 장애 복구 의미론과 `NO_GO` 판정의 오판 위험이 크다.

### 실행 프롬프트

```text
FastPass 예약 소비자가 Redis에서 메시지를 꺼낸 뒤 DB 처리에 실패할 때 메시지가 유실되는지 검증해 줘.

먼저 다음을 읽어라.
- docs/performance/CHANGE_PLAN.md
- src/reservation/reservation.service.ts의 processNextReservation
- src/reservation/reservation.scheduler.ts
- Redis 및 DB 관련 테스트

목표:
1. 예약 메시지가 queue에 있는 상태를 만든다.
2. dequeue 이후 DB transaction이 실패하도록 결정적으로 주입한다.
3. 실패 뒤 원본 queue, processing queue 또는 DLQ에 메시지가 남는지 확인한다.
4. HTTP accepted 수, processed success/fail, DB 저장 수를 비교한다.
5. 프로세스 종료나 일시적인 DB 오류에서도 복구 가능한지 현재 동작을 증거로 기록한다.
6. queue length가 0이어도 worker가 DB transaction을 수행 중인 상태를 재현하고, processing/in-flight 추적 없이 drain 완료로 오판하지 않는지 검증한다.
7. accepted ID, enqueue ID, 처리 성공 ID, retry/DLQ ID, DB ID의 집합을 대조해 유실과 중복을 각각 탐지한다.

이 단계에서는 먼저 실패 주입 통합 테스트와 docs/performance/QUEUE_DURABILITY.md를 작성하라.

현재 설계가 메시지를 유실한다면:
- 테스트를 억지로 통과시키지 마라.
- Redis processing list + ack/requeue, Redis Streams consumer group, 기존 list 기반 보상 처리 등 가능한 대안을 비교하라.
- delivery semantics, idempotency, 중복 처리, 재시도 한도, poison message, DLQ, 다중 PM2 worker 영향과 migration 전략을 설명하라.
- 주요 큐 구조 변경은 자동으로 구현하지 말고 추천안과 예상 변경 범위를 제시한 뒤 사용자 승인을 기다려라.
- 승인 전에는 포트폴리오에서 no-loss 또는 장애 복구 완료를 주장하지 마라.
- 유실이 재현되거나 ID/in-flight를 관측할 수 없으면 이 단계를 `NO_GO`로 기록한다. 처리량 qualification, Spike·Soak와 포트폴리오 성과 반영으로 진행하지 마라. 원인 규명을 위한 저부하 진단이 꼭 필요하면 격리 환경·별도 승인 manifest·보수적 상한을 요구하고 결과를 `NON_QUALIFYING`으로 표시한다.
- 사용자 승인으로 큐 구조를 수정한 뒤에는 DB 실패, worker 강제 종료, retry 초과, poison message, 중복 delivery를 포함한 격리 통합 테스트와 3단계 ID 감사가 모두 통과해야 `NO_GO`를 해제한다.

원격 Redis나 DB에 장애를 주입하지 마라. 로컬 또는 격리된 테스트 더블·통합 환경만 사용하라.

검증:
- git diff --check
- npm run build
- 실패 주입 테스트
- 기존 예약 테스트 회귀 확인

완료 보고:
- 현재 delivery semantics
- 유실 재현 여부
- 재현에 사용한 테스트
- 추천 설계와 대안
- 다음 단계 진행 가능 여부
- `NO_GO` 설정 또는 해제 근거
를 명확히 보고하라.
```

### 완료 Gate

- 큐 소비 실패 시 현재 동작이 자동 테스트로 드러난다.
- 유실 위험, 관측 불능, in-flight 오판 가능성 중 하나라도 남아 있으면 `NO_GO`이며 처리량 qualification, Spike·Soak와 성과 반영이 차단된다. 별도 승인된 `NON_QUALIFYING` 진단 Run은 결함 재현에만 사용할 수 있다.
- 구조 변경이 필요하면 사용자 승인 전까지 구현하지 않는다.
- 복구 설계와 ID 단위 보존 법칙이 격리 환경에서 통과한 경우에만 `INTEGRATION_VERIFIED`로 기록한다.

---

## 8단계 — 부하 테스트용 관측성 보강

> **권장 Codex 추론 수준:** `high` — 앱·PM2·Redis·DB 지표를 정확한 집계 규칙으로 연결한다.

### 실행 프롬프트

```text
FastPass 부하 테스트에서 HTTP 접수와 DB 영속화 병목을 함께 관찰할 수 있도록 관측성을 보강해 줘.

먼저 다음을 읽어라.
- docs/performance/CHANGE_PLAN.md
- 이전 단계의 CURRENT_STATE.md와 QUEUE_DURABILITY.md
- src/reservation/reservation.module.ts
- src/reservation/reservation.service.ts
- src/reservation/reservation.scheduler.ts
- src/tracing.ts
- prometheus.yml.template
- docker-compose.monitoring.yaml

추가 또는 정비할 지표:
- reservation request 총수
- accepted / expected conflict / unexpected failure
- Lua 결과 OK / FAIL / MISS
- enqueue 성공·실패
- processed 성공·실패
- Redis queue 현재 길이
- processing/in-flight, retry, DLQ 현재 길이
- 가장 오래된 queue message 나이
- enqueue부터 DB commit까지의 영속화 지연 Histogram
- scheduler batch 처리량과 처리 시간
- Node event-loop lag, process RSS/heap, restart 관찰 방법

요구사항:
1. userId, seatId, reservationId, runId 같은 고카디널리티 값을 Prometheus label로 사용하지 않는다.
2. 기존 metric 이름과 label 의미를 검토하고 실제로 증가하지 않는 fail counter를 바로잡는다.
3. 4단계에서 확정한 구조화 오류 계약을 그대로 사용해 정상 좌석 충돌과 Redis/DB 장애를 API와 metric에서 구분한다. 계약 변경이 필요하면 4단계 문서·Swagger·테스트를 먼저 함께 갱신한다.
4. 테스트 환경에서만 Prometheus scrape interval을 1~5초로 조정할 수 있게 하고 운영 기본값과 분리한다.
5. 현재 1초 미만 span을 전부 버리는 정책을 환경변수화한다. 성능 비교 시 tracing on/off 조건을 기록할 수 있게 한다.
6. tracing을 켠 경우에도 무제한 100% export로 부하 결과를 왜곡하지 않도록 명시적인 sampling 정책을 사용한다.
7. 필요한 PromQL과 Grafana 패널 정의를 docs/performance/METHODOLOGY.md에 기록한다.
8. 각 Run 시간창의 앱·DB·Redis 관측 요약을 `k6/results/<run-id>/server-metrics.json`으로 내보내되, 원본 쿼리·시간대·누락 지표를 함께 기록한다.

검증:
- git diff --check
- npm run build
- 관련 Jest 테스트
- docker compose config --quiet
- docker compose -f docker-compose.monitoring.yaml config --quiet
- docker compose -f docker-compose.prod.yaml config --quiet
- /metrics sample에서 새 지표 이름과 label cardinality 확인

원격 모니터링 환경에는 배포하지 마라.

완료 보고:
- 추가·수정한 지표
- label 설계
- tracing/scrape 환경별 설정
- PromQL 목록
- 검증 결과
를 요약하라.
```

### 완료 Gate

- 접수, queue 적체, 영속화 성공·실패와 지연을 한 실행 구간에서 관찰할 수 있다.
- 고카디널리티 label이 없다.
- 관측성 설정이 테스트와 운영 환경에서 분리된다.
- sample/정적 지표 검증은 `STATIC_VERIFIED`, 실제 격리 환경에서 request→enqueue→in-flight→commit 흐름이 관측된 경우만 `INTEGRATION_VERIFIED`로 기록한다.

---

## 9단계 — VU 기반 Capacity Test 구현

> **권장 Codex 추론 수준:** `medium` — 확정된 공통 규칙을 적용하는 범위가 명확한 구현 단계다.

### 실행 프롬프트

```text
FastPass의 동시 사용자 증가 영향을 측정하는 VU 기반 k6 시나리오를 구현해 줘.

먼저 docs/performance/CHANGE_PLAN.md, METHODOLOGY.md와 기존 새 k6 공통 모듈을 읽어라.

구현 대상:
- k6/scenarios/capacity-vu.js

요구사항:
1. ramping-vus executor를 명시적으로 사용한다.
2. 기본 단계는 100 → 500 → 1,000 → 2,000 VU이고 단계별 유지 시간은 환경변수로 바꿀 수 있게 한다.
3. 이 테스트에서는 RPS를 목표로 강제하지 않고 실제 결과로 기록한다.
4. 사용자 행동과 think time을 설정으로 노출하고 metadata에 남긴다.
5. 정상 예약 성공 경로와 이미 소진된 좌석의 충돌 경로를 하나의 latency로 섞지 않는다.
6. 충분한 고유 좌석을 사용하는 프로필과 hot-seat 경쟁 프로필을 별도 실행으로 구분한다.
7. accepted, expected conflict, unexpected error outcome별 p95/p99 threshold를 분리한다.
8. 사전 발급 사용자·토큰과 fixture 생성을 측정 구간에서 제외한다.
9. Run ID 결과 저장과 사후 DB 감사에 연결한다.
10. 사용자와 고유 좌석 배정은 로컬 `__VU`만 사용하지 말고 `k6/execution`의 전역 iteration 식별자 또는 사전 생성된 요청 manifest를 사용해 분산 실행·execution segment에서도 중복되지 않게 한다.
11. VU 탐색의 verdict는 고정 RPS 달성 여부가 아니라 단계별 실제 RPS, latency, 오류, 자원 포화, queue/drain으로 판단한다. 탐색 Run을 회귀 테스트의 PASS/FAIL 기준과 섞지 않는다.

이 단계에서는 원격 테스트를 실행하지 마라. 로컬에서는 소규모 프로필만 허용한다.

검증:
- git diff --check
- npm run build
- k6 inspect --execution-requirements k6/scenarios/capacity-vu.js
- inspect 결과가 ramping-vus이고 각 stage가 의도대로 표시되는지 확인
- 가능하면 축소된 로컬 Smoke 실행

완료 보고:
- stages와 환경변수
- 성공·충돌 데이터셋 분리 방식
- think time과 실제 RPS 해석 방법
- 분산 실행 시 사용자·좌석 배정 방식
- VU 탐색 전용 verdict
- 검증 결과
를 요약하라.
```

### 완료 Gate

- VU와 RPS를 혼용하지 않는다.
- 성공 경로와 충돌 경로가 결과에서 분리된다.
- 원격 고부하 없이 시나리오 정적 검증이 완료된다.
- 정적 검증 상태는 `STATIC_VERIFIED`이며 실제 capacity 검증으로 표현하지 않는다.

---

## 10단계 — RPS 기반 처리량 테스트 구현

> **권장 Codex 추론 수준:** `high` — 부하 모델과 처리량·포화 판정을 잘못 혼용하지 않아야 한다.

### 실행 프롬프트

```text
FastPass의 지속 가능한 예약 처리량을 측정하는 RPS 기반 k6 시나리오를 구현해 줘.

먼저 docs/performance/CHANGE_PLAN.md, METHODOLOGY.md와 9단계 VU 시나리오를 읽어라.

구현 대상:
- k6/scenarios/capacity-rps.js
- 필요하면 탐색과 확정을 구분하는 profile 설정

요구사항:
1. 탐색 프로필은 ramping-arrival-rate를 사용한다.
2. 확정 프로필은 constant-arrival-rate를 사용한다.
3. 각 iteration은 예약 HTTP 요청 하나만 발생시키고 RPS profile에서는 `timeUnit=1s`로 고정한다. offered iteration/s, 실제 시작한 예약 요청/s, 서버 enqueue/s, 완료 응답/s를 별도 기록한다.
4. arrival-rate 시나리오 안에는 sleep을 넣지 않는다.
5. rate, preAllocatedVUs, maxVUs, duration을 검증된 환경변수로 받는다. `timeUnit`을 노출해야 한다면 RPS profile에서는 `1s` 외 값을 거부하고, 다른 단위를 허용하는 별도 profile은 초당 값으로 환산해 이름과 보고서에 명시한다.
6. dropped_iterations를 핵심 실패 지표로 사용한다.
7. 정상 성공 경로를 측정할 때는 충분한 고유 좌석을 사용한다.
8. 좌석이 소진된 뒤의 409 처리량은 별도 프로필로 표시하고 예약 처리량으로 해석하지 않는다.
9. 첫 탐색 기본값은 100, 300, 500, 1,000 RPS 단계로 하고 이후 증가는 이전 단계 결과를 보고 결정하게 한다.
10. 한계 후보의 50%, 75%, 100%, 110%를 지속 실행할 수 있는 확정 profile을 제공한다.
11. 결과 저장, metadata, queue drain, DB 감사와 연결한다.
12. 탐색 profile은 `LIMIT_FOUND`/`LIMIT_NOT_FOUND`와 포화 원인을 기록하며, 의도한 한계 초과에서 dropped iteration이나 latency threshold가 깨져도 구현 실패로 오분류하지 않는다.
13. 확정 profile만 사전에 정한 지속 처리량 SLO와 `dropped_iterations=0` 등의 PASS/FAIL을 적용한다. 110% profile은 붕괴·회복 관찰용이며 안정 처리량 PASS 조건을 적용하지 않는다.
14. 정상 성공 profile의 좌석·사용자는 분산 실행에도 안전한 전역 iteration ID 또는 fixture request manifest로 배정한다.

이 단계에서는 원격 테스트를 실행하지 마라.

검증:
- git diff --check
- npm run build
- k6 inspect --execution-requirements k6/scenarios/capacity-rps.js
- inspect 결과에 constant-arrival-rate 또는 ramping-arrival-rate와 rate/timeUnit/preAllocatedVUs/maxVUs가 나타나는지 확인
- 기존 stages 안의 무효한 rate 패턴이 새 파일에 없는지 rg로 확인
- 가능하면 축소된 로컬 Smoke 실행

완료 보고:
- 탐색·확정 profile 차이
- offered iteration, 시작한 예약 요청, 서버 enqueue, 완료 응답 수와 RPS의 관계
- VU pre-allocation 산정 방식
- dropped iteration 통과 기준
- 탐색·확정·110% profile별 verdict 규칙
- 검증 결과
를 요약하라.
```

### 완료 Gate

- `k6 inspect`에서 올바른 arrival-rate executor와 rate 설정이 확인된다.
- 정상 예약 처리량과 충돌 거절 처리량이 분리된다.
- 결과에서 목표 RPS와 실제 RPS를 비교할 수 있다.
- `k6 inspect`만 통과한 상태는 `STATIC_VERIFIED`이며 처리량 수치로 보고하지 않는다.

---

## 11단계 — Spike·Soak 시나리오와 중단 기준 구현

> **권장 Codex 추론 수준:** `high` — 대용량 Fixture, 장시간 실행과 자동 중단 조건을 함께 설계한다.

### 실행 프롬프트

```text
FastPass의 급격한 유입 회복성과 장시간 안정성을 검증하는 Spike 및 Soak 시나리오를 구현해 줘.

먼저 docs/performance/CHANGE_PLAN.md와 8~10단계 결과를 읽어라.

구현 대상:
- k6/scenarios/spike.js
- k6/scenarios/soak.js
- docs/performance/LOAD_TEST_RUNBOOK.md

Spike 기본 흐름:
- 기준 부하 2분
- 급증 부하 30초
- 기준 부하로 복귀 후 3분 관찰

Soak 기본 흐름:
- 확인된 지속 가능 처리량의 60~70%
- 최소 60분

요구사항:
1. 기준·급증 RPS와 duration은 환경변수화한다.
2. accepted latency, dropped iterations, queue 최대 길이, queue drain, DB 영속화 지연을 결과에 포함한다.
3. 앱 CPU·메모리·event-loop lag·PM2 restart, Redis·DB 상태를 동일 시간 범위로 관찰하는 방법을 Runbook에 작성한다.
4. 다음 중단 조건의 초기안을 Runbook에 포함한다.
   - 예상하지 않은 오류율 급증
   - ALB unhealthy target 발생
   - DB connection 한도 접근
   - Redis eviction 또는 지속적인 timeout
   - queue가 부하 종료 뒤에도 감소하지 않음
   - k6 발생기 CPU 포화 또는 dropped iteration 증가
5. 테스트 데이터 용량과 종료 후 cleanup 절차를 작성한다.
6. 원격 대상, 최대 부하, 허용 시간, 비용 책임자가 확인되지 않으면 실행하지 않도록 runner와 Runbook에 경고를 둔다.
7. 성공 경로에 필요한 fixture를 `목표 RPS × 실행 초 × 요청당 고유 좌석 수 × 안전 여유`로 사전 계산한다. 사용자·좌석·예상 DB 행·Redis 메모리·저장 용량·생성/cleanup 시간을 preflight에 표시하고 승인된 상한을 넘으면 실행을 거부한다.
8. 수백만 행을 애플리케이션 메모리 배열로 한 번에 만들지 않는다. 격리 환경에서만 동작하는 chunk/bulk seed, 진행 checkpoint, 중단 후 재개/정확한 cleanup 방식을 설계한다.
9. access token TTL이 setup + 실행 + queue drain + 감사 시간을 충분히 덮는지 preflight에서 확인한다. 부족하면 테스트 전용의 명시적 TTL 설정 또는 안전한 토큰 갱신 방식을 사용하고 metadata에 기록한다. 401을 서버 capacity 오류나 정상 충돌로 집계하지 않는다.
10. Spike의 verdict는 급증 중 SLO와 기준 부하 복귀 뒤 오류율·latency·queue가 기준 범위로 돌아오는 회복 시간으로 정의한다. Soak는 시간 구간별 SLO, 메모리/queue 증가 추세, restart, 최종 drain·ID 감사로 판정한다.
11. Runbook에 자동 watchdog의 입력 지표, polling 간격, 연속 위반 횟수, k6 중단 방법, 중단 사유 artifact 보존 방법을 정의한다. 화면을 사람이 지켜보는 것만을 중단 장치로 삼지 않는다.

이 단계에서는 실제 원격 Spike/Soak를 실행하지 마라. 로컬에서는 축소된 구성만 허용한다.

검증:
- git diff --check
- npm run build
- 두 시나리오의 k6 inspect
- Runbook의 사전 점검, 중단, 사후 감사, cleanup 절차 검토

완료 보고:
- Spike/Soak profile
- 중단 기준
- 필요한 데이터 규모
- fixture 산식·용량 상한과 인증 TTL 처리
- Spike·Soak별 verdict와 watchdog
- 모니터링·cleanup 절차
- 검증 결과
를 요약하라.
```

### 완료 Gate

- 원격 실행 전 필요한 승인 정보와 중단 기준이 Runbook에 있다.
- Spike와 Soak의 목적·지표·데이터 규모가 분리된다.
- fixture 규모·토큰 TTL·저장 용량이 실행 전에 계산되고 상한 초과 시 fail-closed 한다.
- 정적 검증만이면 `STATIC_VERIFIED`, 격리 환경의 축소 실행에서 watchdog·drain·감사까지 확인한 경우에만 `INTEGRATION_VERIFIED`로 기록한다.

---

## 12단계 — 승인된 환경에서 기준선·후보 실제 테스트 실행

> **권장 Codex 추론 수준:** `xhigh` — 실제 원격 부하의 승인 범위, 중단과 cleanup을 안전하게 통제한다.

### 실행 프롬프트

```text
FastPass의 변경 전 기준선과 변경 후보를 동일한 승인 범위 안에서만 순차 실행해 줘.

먼저 다음을 읽어라.
- docs/performance/CHANGE_PLAN.md
- docs/performance/METHODOLOGY.md
- docs/performance/LOAD_TEST_RUNBOOK.md
- docs/performance/CURRENT_STATE.md
- 이전 단계에서 만든 모든 k6 시나리오와 runner
- 7단계 QUEUE_DURABILITY.md와 NO_GO 상태

먼저 machine-readable 승인 manifest의 schema를 검증하라. manifest에는 최소한 다음 값이 정확히 있어야 한다.
- 정확한 BASE_URL과 환경 이름
- 환경 고유 ID와 격리·일회성 환경임을 확인할 근거
- 운영이 아님을 나타내는 명시적 값
- 허용된 시나리오 목록
- 허용 시작·종료 시각과 승인 만료 시각(timezone 포함)
- 허용된 최대 VU, RPS, duration, 총 요청 수, fixture 행 수
- 기준선 Git SHA/이미지 digest와 후보 Git SHA/이미지 digest
- ALB·EC2·PM2 worker 수와 사양
- RDS·Redis 사양과 connection 한도
- 테스트 발생기 사양과 네트워크 위치
- Fixture 생성·삭제 권한
- 모니터링 접근 가능 여부
- 비용과 장애 대응 책임자
- 중단 조건과 cleanup 방법
- 승인자와 승인 시각, 변경 불가능한 manifest checksum

위 정보와 원격 부하 실행에 대한 사용자의 명시적 승인이 없거나 manifest가 만료·불일치하면 테스트를 실행하지 말고 준비 상태와 누락 항목만 보고하라. 승인 manifest는 runner가 생성·수정하거나 누락값을 추측해 채우지 않는다. `ALLOW_REMOTE_LOAD=true`만으로는 실행할 수 없다. 운영 환경은 승인 여부와 관계없이 금지하며, 스테이징도 전용 DB·Redis와 삭제 가능한 fixture가 보장된 격리 환경일 때만 허용한다.

실행 전 강제 조건:
- qualification, Spike·Soak를 실행하려면 7단계 `NO_GO`가 해제되고 `INTEGRATION_VERIFIED`여야 한다. `NO_GO` 상태에서는 결함 재현 목적의 별도 승인 manifest가 있는 저부하 `NON_QUALIFYING` 진단 Run만 허용하고 아래 기준선·후보 성능 순서는 실행하지 않는다.
- 4단계 오류 계약과 3단계 ID 감사가 `INTEGRATION_VERIFIED`여야 한다.
- 로컬/격리 축소 Smoke가 `INTEGRATION_VERIFIED`여야 한다. inspect만 성공한 상태에서는 원격으로 넘어가지 않는다.
- runner가 현재 시각, BASE_URL, 환경 ID, scenario, VU/RPS/duration/총 요청, fixture 규모, Git SHA/이미지 digest를 승인 manifest와 매 실행 직전에 대조해야 한다.
- watchdog가 시작되고 지표를 읽을 수 있음을 확인하기 전에는 k6를 시작하지 않는다. 승인 상한·시간창 위반 또는 중단 조건 연속 충족 시 자동으로 k6를 종료하고 원인을 artifact에 남긴다.

승인 후 실행 순서:
1. 승인 manifest checksum, Git SHA, 이미지 digest, k6 버전, 인프라 설정을 metadata에 고정
2. 기존 queue·in-flight·DLQ가 비었는지와 테스트 데이터 경계를 확인
3. fixture 산식과 token TTL을 다시 계산하고 생성 ID를 fixture-manifest.json에 기록
4. 승인된 기준선 SHA/이미지를 배포한 뒤 원격 Smoke와 축소 정합성 Test 실행
5. 기준선 queue/in-flight drain, ID 단위 DB 감사와 artifact finalize
6. 기준선 VU/RPS profile을 낮은 단계부터 승인 범위 안에서 실행하고 확정 조건을 동일하게 3회 반복
7. 후보 SHA/이미지를 같은 인프라 설정에 배포하고 migration·설정 차이를 metadata에 기록
8. 후보 Smoke와 축소 정합성 Test를 통과한 뒤에만 VU/RPS profile 실행
9. 후보 한계 확정 조건을 동일하게 3회 반복
10. 승인 범위 안에서 Spike Test 실행
11. 안정적인 한계와 충분한 fixture/token TTL이 확인된 경우에만 Soak Test 실행
12. 각 실행 직후 producer 종료, queue/in-flight 안정화와 ID 집합 감사를 수행
13. cleanup dry-run 검토 후 해당 Run이 만든 ID만 삭제하고 잔여 queue·in-flight·DLQ·DB 데이터가 없는지 확인
14. 감사·cleanup 결과, 중단 사유, checksum을 기록한 뒤에만 artifactSet을 `FINALIZED`로 전환

비교 가능한 기준선 SHA/이미지를 재현할 수 없거나 동일한 방법론·인프라에서 실행하지 못하면 후보 절대값만 보고하고 개선율·개선 전후 비교를 작성하지 마라.

운영 원칙:
- 앞 단계의 중단 조건을 만족하면 즉시 다음 부하 상승을 중단한다.
- 실패한 Run을 삭제하거나 성공 Run으로 덮어쓰지 않는다.
- 같은 Run ID를 재사용하지 않는다.
- `FAILED`/`ABORTED` 실행의 artifact도 보존한다. 성공 여부와 무관하게 생성 가능한 실패 보고서·감사·checksum 검증까지 끝난 artifact set만 `FINALIZED`로 봉인하고 실행 결과는 별도 status로 유지한다.
- 테스트 중 코드를 수정하지 않는다.
- k6 발생기 자체가 병목이면 서버 한계로 결론내리지 않는다.
- 사용자 승인 한도를 임의로 확대하지 않는다.
- 탐색, 확정, 110%, Spike, Soak에 각기 정의된 verdict를 적용한다. 모든 Run에 공통으로 `dropped_iterations=0`을 강요하지 않는다.

각 Run 후 보고:
- Run ID
- 목표와 실제 부하
- threshold 통과 여부
- 201/409/기타 오류
- p95/p99
- dropped iterations
- queue 최대·배출 시간
- DB 정합성
- accepted/DB ID 누락·초과·중복과 in-flight/DLQ
- 서버·DB·Redis 최대 사용량
- artifact 상태와 watchdog 중단 여부
- 다음 단계 진행 또는 중단 결정
을 간결히 제공하라.
```

### 완료 Gate

- 만료되지 않은 승인 manifest와 자동 watchdog가 강제한 격리 환경·범위에서만 실행된다.
- 모든 Run의 artifact와 실패 기록이 보존된다.
- 기준선과 후보의 동일 조건 확정 Run이 각각 3회 존재하거나, 기준선 부재로 개선 비교가 불가함이 명시된다.
- 모든 성공 Run은 ID 단위 감사와 cleanup 확인까지 끝난 artifactSet=`FINALIZED` 상태다.
- 위 조건을 충족한 경우에만 `REMOTE_VERIFIED`로 기록한다.

---

## 13단계 — 결과 분석과 포트폴리오 반영

> **권장 Codex 추론 수준:** `high` — 여러 Run의 증거를 대조하고 과장 없는 결론을 작성한다.

### 실행 프롬프트

```text
FastPass의 새 k6 실행 결과를 분석하고 검증된 내용만 포트폴리오와 저장소 문서에 반영해 줘.

먼저 다음을 읽어라.
- docs/performance/CHANGE_PLAN.md
- docs/performance/CURRENT_STATE.md
- docs/performance/METHODOLOGY.md
- k6/results/*의 승인되고 artifactSet=`FINALIZED`인 Run artifact
- README.md
- RETROSPECTIVE.md
- portfolio/*.md
- work_logs/*.md

작업:
1. 동일 조건 3회 결과에서 중앙값, 최소·최대 범위, 재현성을 계산한다.
2. 최고 성능 Run 하나만 골라 결과를 과장하지 않는다.
3. VU 결과와 RPS 결과를 별도 표와 문장으로 작성한다.
4. accepted 응답 지연과 DB 영속화 지연을 분리한다.
5. 정상 예약과 예상 충돌의 latency·처리량을 분리한다.
6. queue 최대 길이, drain 시간, 처리 실패, DB 정합성을 함께 설명한다.
7. CPU·메모리·DB 연결·Redis 지표와 k6 지표를 같은 시간 구간으로 연결해 병목을 해석한다.
8. 기존 3,000 RPS, 100% 정합성, DB Read 90% 감소 주장을 새 증거와 대조하고 verified인 내용만 유지한다.
9. 실패한 실험, 큐 내구성 한계, tracing/logging 오버헤드, 발생기 한계를 숨기지 않고 기록한다.
10. README.md, RETROSPECTIVE.md, portfolio/verification_strategy.md를 새 사실에 맞게 갱신한다.
11. docs/performance/PORTFOLIO_UPDATE.md에 Obsidian에 복사할 수 있는 완성 문안을 작성한다.
12. Obsidian 원본 파일 경로가 저장소 밖에 있거나 명확하지 않으면 직접 수정하지 말고 PORTFOLIO_UPDATE.md만 제공한다.
13. 모든 성능 수치 옆에 Run ID 또는 결과 파일 링크를 둔다.
14. 개선율은 동일 승인 manifest의 인프라·fixture·관측 설정·profile로 실행한 기준선과 후보가 각각 3회 있고 artifactSet이 모두 `FINALIZED`일 때만 계산한다. 조건이 다르면 절대값을 별도로 제시하고 인과적 개선 주장을 하지 않는다.
15. 7단계 `NO_GO`가 남아 있거나 accepted/DB ID 집합 감사가 실패한 Run은 성능 성과 근거에서 제외하고 제한사항으로만 기록한다.
16. 시작과 종료 시 `git ls-files`, `git check-ignore -v`, `git status --short`로 README, RETROSPECTIVE, portfolio, work_logs, docs/performance 문서의 추적 상태를 확인한다.
17. `portfolio/`가 ignore되어 있으면 수정 사실을 Git 반영 완료로 보고하지 않는다. ignore 정책을 임의로 바꾸지 말고, 추적되는 `docs/performance/PORTFOLIO_UPDATE.md`에 완성 문안과 대상 경로를 제공한 뒤 원본 추적 정책 변경은 사용자 결정으로 남긴다.
18. `docs/performance/PORTFOLIO_UPDATE.md` 자체가 추적되지 않는 상태라면 완료로 처리하지 말고, 추적 가능한 산출물로 만드는 방법과 필요한 사용자 결정을 보고한다.

결과 표 필수 열:
- Run
- 부하 모델
- 목표 부하
- 실제 RPS
- accepted p95/p99
- 201/409/5xx
- dropped iterations
- queue 최대/배출 시간
- DB 영속화 p95
- CPU/DB connection
- 정합성 결과

검증:
- git diff --check
- README와 portfolio 문서의 링크 검사
- 문서에 기록된 모든 새 숫자가 artifact에 존재하는지 대조
- unsupported 또는 contradicted 주장이 확정 성과로 남아 있지 않은지 rg로 확인
- npm run build와 관련 테스트를 마지막으로 실행
- 인용한 모든 Run의 artifactSet이 `FINALIZED`이고 checksum·승인 manifest·ID 감사가 유효한지 확인
- 변경 대상으로 보고한 모든 문서가 실제 Git diff 또는 명시된 외부/ignored 전달물에 나타나는지 확인

완료 보고:
- 반영한 검증 성과
- 삭제·보류한 과거 주장
- 남은 한계
- 포트폴리오 문서 경로
- 각 문서의 tracked/ignored 상태와 실제 전달 방식
- 근거 Run ID 목록
을 요약하라.
```

### 완료 Gate

- 모든 성능 숫자가 특정 Run과 연결된다.
- VU, RPS, 접수, 영속화가 분리되어 설명된다.
- 실패와 한계를 포함한 포트폴리오 문안이 완성된다.
- 기준선이 비교 불가능한 경우 개선율 주장이 없고, 큐 `NO_GO`가 남은 경우 내구성 성과 주장이 없다.
- 저장소 반영 파일과 ignored/외부 전달물이 명확히 구분된다.

---

## 전체 정적 검증 체크리스트

구현 단계가 모두 끝난 뒤 다음 항목을 확인한다.

```bash
git diff --check
npm run build
k6 version
k6 inspect --execution-requirements k6/scenarios/smoke.js
k6 inspect --execution-requirements k6/scenarios/consistency-one-seat.js
k6 inspect --execution-requirements k6/scenarios/consistency-inventory.js
k6 inspect --execution-requirements k6/scenarios/rebooking.js
k6 inspect --execution-requirements k6/scenarios/capacity-vu.js
k6 inspect --execution-requirements k6/scenarios/capacity-rps.js
k6 inspect --execution-requirements k6/scenarios/spike.js
k6 inspect --execution-requirements k6/scenarios/soak.js
docker compose config --quiet
docker compose -f docker-compose.monitoring.yaml config --quiet
docker compose -f docker-compose.prod.yaml config --quiet
```

로컬 Smoke Test는 API뿐 아니라 그 뒤의 DB·Redis가 전용 일회성 환경임을 확인한 경우에만 실행한다. 아래 placeholder를 검증된 환경 ID로 바꾸지 않으면 runner가 거부해야 한다.

```bash
BASE_URL=http://127.0.0.1:3000 \
TEST_ENV_ID=REPLACE_WITH_VERIFIED_DISPOSABLE_ENV_ID \
ALLOW_TEST_DATA_MUTATION=true \
RUN_ID=local-smoke-$(date +%Y%m%d-%H%M%S) \
k6 run k6/scenarios/smoke.js
```

결과 artifact 검증 예시는 다음과 같다.

```bash
RUN_ID=REPLACE_WITH_FINALIZED_RUN_ID
RUN_RESULT_DIR="k6/results/${RUN_ID}"
find "$RUN_RESULT_DIR" -maxdepth 1 -type f -print
jq empty "$RUN_RESULT_DIR/metadata.json"
jq empty "$RUN_RESULT_DIR/fixture-manifest.json"
jq empty "$RUN_RESULT_DIR/summary.json"
jq empty "$RUN_RESULT_DIR/consistency-audit.json"
jq empty "$RUN_RESULT_DIR/server-metrics.json"
test -s "$RUN_RESULT_DIR/report.md"
rg -n '(Bearer |accessToken|refreshToken|JWT_SECRET|DATABASE_URL|Authorization|Set-Cookie|postgres(ql)?://|redis(s)?://)' "$RUN_RESULT_DIR"
```

마지막 `rg` 명령은 보조 검사이며 출력이 없어야 정상이다. 이 검사만으로 안전하다고 판정하지 말고 JSON artifact allowlist schema, header·환경변수 비저장 테스트와 사용 가능한 secret scanner를 함께 적용한다.
