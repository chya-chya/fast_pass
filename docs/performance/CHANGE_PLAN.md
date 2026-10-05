# FastPass 성능 재검증 및 포트폴리오 변경 계획

단계별 실제 작업 지시는 [EXECUTION_PROMPTS.md](./EXECUTION_PROMPTS.md)를 따른다.

## 1. 목적

FastPass의 동시성 제어와 처리 성능을 단순한 VU·RPS 숫자가 아니라 재현 가능한 실행 기록과 최종 데이터 정합성으로 증명한다.

이 계획의 결과물은 다음 질문에 답할 수 있어야 한다.

- 동일한 코드와 인프라에서 같은 결과를 다시 만들 수 있는가?
- HTTP `201` 응답이 실제 DB 영속화까지 이어졌는가?
- 정상적인 좌석 충돌과 시스템 장애를 구분했는가?
- 몇 명의 동시 사용자와 몇 RPS를 검증했는지 구분했는가?
- 병목이 애플리케이션, Redis, DB, 네트워크 중 어디에서 발생했는가?
- 포트폴리오의 모든 수치가 원본 실행 결과와 연결되는가?

## 2. 현재 상태와 변경 근거

| 항목 | 현재 상태 | 위험 | 변경 방향 |
| --- | --- | --- | --- |
| 원격 대상 안전성 | 기존 부하 스크립트에 원격 주소가 기본값 또는 고정값으로 남아 있을 수 있음 | 로컬 검증 의도로 실행해도 승인되지 않은 환경에 부하를 보낼 수 있음 | 레거시 진입점을 먼저 격리하고 명시적 대상·승인 manifest 없이는 원격 실행을 차단 |
| 3,000 부하 표현 | [`load-test.js`](../../k6/load-test.js)는 `stages` 기반 3,000 VU 테스트이며 stage의 `rate: 3000`은 RPS를 고정하지 않음 | 3,000 RPS로 오해할 수 있음 | VU 테스트와 arrival-rate 기반 RPS 테스트를 분리 |
| 정합성 검증 | [`consistency-test.js`](../../k6/consistency-test.js)는 `201` 수를 세고 `<= 50`이라는 로그만 출력 | 0건 성공이나 DB 유실도 통과 가능 | producer 종료와 pending·in-flight·retry 안정화를 확인한 뒤 접수·처리·DB ID 집합과 좌석 상태를 자동 검증 |
| 성공의 의미 | 예약 API의 `201`은 Redis 큐 적재가 완료된 시점 | DB 저장 실패를 성공으로 기록할 수 있음 | 접수 지연과 DB 영속화 지연을 별도 측정 |
| 오류 분류 | 좌석 충돌과 일부 Redis/Queue 오류가 모두 `409`로 나타날 수 있음 | 인프라 장애를 정상 충돌로 집계할 수 있음 | 구조화된 오류 코드와 결과별 Counter/Rate 사용 |
| 데이터셋 | 적은 좌석이 빠르게 소진된 뒤 반복 요청 | 전체 p95가 빠른 충돌 경로를 대표할 수 있음 | 성공 경로와 Hot-seat 충돌 경로를 별도 실행 |
| 실행 기록 | 콘솔·웹 대시보드 중심이며 원본 결과와 환경 정보가 없음 | 과거 수치를 재검증하기 어려움 | Run ID별 metadata, summary, audit, report 저장 |
| 관측성 | Prometheus 수집 주기 15초, Jaeger는 1초 미만 span을 제외 | 짧은 spike와 정상 지연 구간이 보이지 않음 | 테스트 환경 전용 수집 주기와 샘플링 정책 적용 |
| 재예약 | 취소된 Reservation 행이 남고 `seatId`는 Unique | 취소·만료 뒤 재예약이 비동기 DB INSERT에서 실패할 수 있음 | 회귀 테스트를 추가하고 실패 시 먼저 수정 |
| 큐 완료 판정 | 대기 큐 길이만 0이면 처리가 끝난 것으로 볼 수 있음 | worker가 메시지를 꺼낸 뒤 처리 중이거나 재시도·실패 저장소로 이동한 상태를 놓칠 수 있음 | pending, processing/in-flight, retry, DLQ와 접수 ID·저장 ID 집합을 함께 감사 |
| 개선 전후 비교 | 같은 방법론으로 남긴 변경 전 기준선이 없음 | 서로 다른 코드·데이터·부하 모델의 결과를 개선율로 오해할 수 있음 | 애플리케이션 개선 전에 격리된 기준선 Run을 보존하고 동일 조건끼리만 비교 |
| 로컬 실행 준비 | 정적 Compose 검사는 실제 DB·Redis TLS 연결, bind mount와 앱 identity를 보장하지 않음 | Smoke를 생략하거나 다른 서비스·공유 자원에 테스트 데이터를 쓸 수 있음 | disposable 환경에서 앱 identity, DB·Redis endpoint/TLS, migration, health와 모니터링 파일을 실제 preflight |

## 3. 변경 원칙

1. VU와 RPS를 같은 의미로 사용하지 않는다.
2. 정상 예약, 예상 충돌, 예상하지 않은 오류를 서로 다른 지표로 기록한다.
3. `201 accepted`와 `DB persisted`를 구분한다.
4. 무작위 데이터보다 재현 가능한 좌석 배정과 실행 ID를 사용한다.
5. 성능 목표와 통과 기준은 본 실행 전에 고정한다.
6. 같은 조건을 최소 3회 실행하고 최댓값 하나가 아니라 중앙값과 범위를 기록한다.
7. Warm Cache와 Cold Cache, Tracing On과 Off를 섞지 않는다.
8. 실행 환경이나 원본 결과가 없는 수치는 포트폴리오 성과로 사용하지 않는다.
9. 운영 환경에는 부하 테스트를 보내지 않는다. 전용 DB·Redis와 삭제 가능한 Fixture가 보장된 격리 비운영 환경만 정확한 대상과 허용 범위를 명시적으로 승인받아 사용한다.
10. 대용량 시계열 원본은 외부 저장소에 보관하고 Git에는 재현에 필요한 요약 자료만 저장한다.
11. Run마다 DB 데이터, Redis key prefix, 큐, 사용자·좌석 범위를 격리하고 생성한 ID만 정리한다.
12. 탐색, 회귀, 회복, 지속성 실험에 동일한 임계값과 PASS 의미를 강제로 적용하지 않는다.
13. 애플리케이션 동작을 바꾸기 전에 동일 방법론의 기준선을 남기며, 기준선이 없으면 개선율을 주장하지 않는다.

## 4. 목표 디렉터리 구조

```text
k6/
  config/
  lib/
  scenarios/
    smoke.js
    consistency-one-seat.js
    consistency-inventory.js
    rebooking.js
    capacity-vu.js
    capacity-rps.js
    spike.js
    soak.js
  run.sh
  results/
    <run-id>/
      metadata.json
      fixture-manifest.json
      summary.json
      consistency-audit.json
      server-metrics.json
      report.md

docs/performance/
  CHANGE_PLAN.md
  EXECUTION_PROMPTS.md
  METHODOLOGY.md
  CURRENT_STATE.md
```

기존 `k6/load-test.js`와 `k6/consistency-test.js`는 새 시나리오가 검증될 때까지 삭제하지 않는다. 이후에는 호환용 진입점으로 남기거나 Deprecated 상태를 명시한다.

모든 실행 산출물의 기준 경로는 `k6/results/<run-id>/` 하나로 통일한다. 문서에서는 이 경로의 파일을 링크하며, 대용량 시계열은 외부 저장소 URI와 무결성 해시만 남길 수 있다. 실패하거나 중단된 Run도 같은 경로에 최소 `metadata.json`과 `report.md`를 남겨 실패 단계와 사유를 추적한다.

## 5. 테스트 변경 계획

### 5.1 공통 실행 기반

- `BASE_URL`, Run ID, VU, RPS, 지속 시간, 사용자 수, 좌석 수를 환경변수로 받는다.
- URL, 비밀번호, 토큰, 인프라 주소를 코드에 하드코딩하지 않는다.
- 대상 URL을 생략했을 때 원격 주소로 대체하지 않는다. 로컬 안전 기본값을 쓰거나 실행을 거부한다.
- 원격 실행은 환경 이름, 정확한 host, 최대 VU, 최대 RPS, 최대 지속 시간, 승인자, 승인 만료 시각을 담은 승인 manifest가 있어야 하며 runner가 실제 인자와 대조한다. 운영 환경은 승인 여부와 관계없이 금지한다.
- 외부 난수 라이브러리 의존을 제거하거나 버전을 고정하고 로컬 실행 재현성을 확보한다.
- Setup 단계의 모든 HTTP 응답과 필수 응답 필드를 검증하고 실패 시 본 테스트를 중단한다.
- 요청에 endpoint, scenario, outcome 태그를 부여한다.
- `handleSummary()`로 `k6/results/<run-id>/summary.json`을 생성한다.
- Run ID별 전용 Performance, 사용자·좌석 범위, Redis key prefix와 큐를 사용한다. 전용 DB/Redis를 사용할 수 없다면 다른 Run과 겹치지 않는 namespace와 소유권 표식을 강제한다.
- Fixture 생성 전에 예상 행 수, Redis key 수, 저장 용량과 실행 비용을 계산하고 허용 한도를 넘으면 본 테스트를 시작하지 않는다.
- 시작 전에 같은 Run namespace가 비어 있는지 확인하고 종료 후에는 큐 처리 완료와 DB 정합성을 감사한다.
- 정리는 `fixture-manifest.json`에 기록된 Run 소유 ID만 대상으로 하며, 삭제 전 대상과 건수를 미리 출력한다. 감사가 끝나기 전에는 데이터를 삭제하지 않고 공유·운영 환경에서는 자동 cleanup을 금지한다.
- preflight, setup, load, drain, audit, cleanup 중 어느 단계에서 실패해도 실행 상태와 실패 사유를 산출물에 남긴다.

### 5.2 시나리오 매트릭스

| 순서 | 시나리오 | 실행 모델 | 핵심 목적 | 완료 조건 |
| --- | --- | --- | --- | --- |
| 1 | Smoke | 1~5 VU | 설정, 인증, Fixture, 결과 저장 확인 | Setup과 Check 100%, 결과 파일 생성 |
| 2 | 단일 좌석 충돌 | `per-vu-iterations` | 하나의 좌석에 대한 배타성 검증 | `201=1`, 나머지 예상 충돌, DB 중복 0 |
| 3 | 50석 재고 경쟁 | `per-vu-iterations`, 1,000 VU가 VU당 1회 | 재고 한도와 분산 충돌 검증 | `201=50`, `409=950`, DB 고유 좌석 50 |
| 4 | 재예약 | 기능·회귀 테스트 | 예약→취소/만료→동일 좌석 재예약 검증 | 두 번째 예약까지 최종 DB 저장 성공 |
| 5 | VU Capacity | `ramping-vus` | 동시 사용자 증가 시 지연·자원 변화 | 단계별 실제 RPS와 지표 기록 |
| 6 | RPS 탐색 | `ramping-arrival-rate` | 처리 한계 탐색 | 병목 구간과 dropped iteration 기록 |
| 7 | RPS 확정 | `constant-arrival-rate` | 지속 가능한 처리량 확정 | 기준 충족 구간을 3회 재현 |
| 8 | Spike | arrival-rate | 급증과 회복 능력 검증 | 큐·응답시간·자원 회복 시간 기록 |
| 9 | Soak | arrival-rate | 장시간 누수와 적체 확인 | 60분 이상 메모리·연결·큐 안정 |

`1,000 VU가 VU당 1회`는 총 1,000개의 단발 요청을 뜻한다. 모든 요청이 같은 순간에 시작됐다는 뜻은 아니므로 실제 요청 시작 시각의 분포와 최대 동시 활성 VU를 함께 기록하고, 포트폴리오에는 “1,000개의 동시 단발 요청” 대신 “1,000 VU가 각각 한 번 요청”이라고 표현한다.

### 5.3 변경 전 기준선

- Phase -1의 안전 격리와 Phase 1의 테스트 기반 구축을 마친 뒤, 재예약·큐 내구성·애플리케이션 성능을 바꾸기 전 revision의 Git SHA, dirty 상태, 재현 가능한 이미지 digest와 migration을 먼저 고정한다.
- 기준선 실제 실행은 모든 공통 시나리오와 runner가 준비된 뒤 승인 단계에서 해당 고정 revision을 다시 배포해 수행할 수 있다. 후보와 동일한 외부 runner, Fixture, 캐시 상태, tracing, 인프라 크기, 부하 발생기와 임계값을 사용한다.
- 기준선 API가 후보의 구조화 오류 계약과 다르면 변경 전 응답을 위한 별도 고정 mapping을 사용하고, 구분할 수 없는 결과는 추측하지 않고 `unsupported` 또는 `INCONCLUSIVE`로 남긴다.
- 기준선 자체에 정합성 실패가 있으면 실패 상태로 보존하며 수치를 숨기지 않는다. 이 결과는 병목과 결함을 설명할 수 있지만 “지속 가능한 처리량”의 근거로 사용하지 않는다.
- 변경 전 기준선을 만들 수 없다면 이후 결과는 현재 상태 검증으로만 표현하고 개선율·감소율 문장을 사용하지 않는다.

### 5.4 정합성 테스트 설계

#### 단일 좌석

- 충분한 수의 사용자 또는 사전 발급 토큰을 준비한다.
- 모든 VU가 동일한 좌석에 한 번만 요청한다.
- 정확히 1건만 접수되고 최종 DB에도 1건만 저장되어야 한다.

#### 50석 균등 경쟁

- 1,000 VU가 각각 한 번만 요청한다.
- `k6/execution`의 전역 iteration 식별자 또는 사전 생성한 immutable 요청 manifest를 사용해 좌석마다 정확히 20개의 요청을 만든다. 단일 발생기만 허용한다고 명시하지 않는 한 로컬 `__VU` 값에 의존하지 않는다.
- 무작위 선택으로 인한 실행별 편차를 제거한다.
- Warm Cache와 Cold Cache를 별도 Run으로 실행한다.
- 요청 시작 시각 분포를 기록해 실제 동시성 수준을 확인한다.

#### 종료 후 감사

- producer가 종료되어 더 이상 새 메시지가 생성되지 않는지 확인한다.
- Redis의 pending queue, processing/in-flight, retry가 모두 0이고 그 상태가 정해진 안정화 시간 동안 유지될 때까지 제한 시간 안에서 기다린다.
- DLQ와 최종 처리 실패가 0인지 확인한다. 0이 아니면 항목별 job ID와 오류 코드를 남기고 Run을 실패 처리한다.
- 테스트 Performance에 속한 Reservation 총수를 계산한다.
- `COUNT(*)`와 `COUNT(DISTINCT seatId)`를 기록하되 시나리오 불변식에 따라 판정한다. 한 Run에서 좌석당 한 번만 저장되는 경쟁 시나리오는 두 값이 같아야 하지만, 재예약 이력을 보존하는 시나리오는 과거 행 중복을 허용하고 활성 상태의 좌석 중복만 0이어야 한다.
- 좌석별 활성 예약이 1건을 초과하는지 확인한다.
- Seat 상태, Reservation 상태, Redis 상태를 비교한다.
- 각 요청에 클라이언트가 미리 생성한 고유 request ID를 부여하고 서버의 접수·job ID와 연결한다. 응답 유실이나 timeout이 있어도 server-enqueued ID, client-observed accepted ID와 DB 영속화 ID를 구분해 직접 비교하고 누락·초과 집합을 저장한다.
- `accepted unique IDs = processed success unique IDs + terminal failure unique IDs`인지 확인하고 재시도로 인한 중복 처리 ID도 검사한다.
- 처리 완료 조건은 queue length 하나가 아니라 pending, processing/in-flight, retry, DLQ, worker 성공·실패 counter와 ID 집합 대조가 모두 완료된 상태다.
- 처리 실패가 있다면 성공으로 숨기지 않고 Run을 실패 처리한다.
- 제한 시간 안에 완료 조건을 만족하지 못하거나 필수 상태를 관측할 수 없으면 `INCONCLUSIVE`가 아니라 정합성 Gate의 `FAIL`로 처리한다. 단, 관측 도구 자체의 고장으로 데이터가 없으면 실행 유효성은 `INVALID`로 별도 표시한다.

### 5.5 VU 기반 테스트

초기 단계안은 다음과 같다.

- 100 VU
- 500 VU
- 1,000 VU
- 2,000 VU
- 단계별 3분 유지

VU 테스트에서는 RPS를 목표로 강제하지 않고 실제 결과로 기록한다. 사용자 행동 모델과 Think Time도 함께 기록한다.

### 5.6 RPS 기반 테스트

먼저 `ramping-arrival-rate`로 대략적인 한계를 찾는다.

- 100 RPS
- 300 RPS
- 500 RPS
- 1,000 RPS
- 이후 이전 단계의 지연, 오류, dropped iteration, 큐 증가율을 보고 확대

한계 구간을 찾은 뒤 50%, 75%, 100%, 110% 수준을 `constant-arrival-rate`로 각각 유지한다. RPS로 이름 붙인 profile은 `timeUnit=1s`로 고정하고 각 iteration이 예약 요청 하나만 만들게 한다. offered iteration/s, 실제 시작한 예약 요청/s, 서버가 관측한 enqueue/s, 완료 응답/s와 `dropped_iterations`를 각각 기록하며 이 값들을 모두 같은 의미의 RPS로 간주하지 않는다.

정상 예약 처리량 측정에는 충분한 고유 좌석을 준비한다. 좌석이 이미 소진된 뒤 발생하는 409 처리량은 별도의 Hot-seat 실험으로만 해석한다.

### 5.7 Spike와 Soak

Spike는 기준 부하 2분, 급증 30초, 기준 부하 복귀 3분으로 시작한다. 최대 큐 길이, 정상 응답시간 회복, 큐 완전 배출 시간을 핵심 결과로 기록한다.

Soak는 확인된 지속 가능 처리량의 60~70%에서 최소 60분 실행한다. 메모리의 단조 증가, Event Loop 지연, DB 연결 누적, Redis Eviction, PM2 재시작, 큐 적체를 확인한다.

성공 경로의 상태가 매 요청마다 누적되는 시나리오는 `목표 RPS × 실행 초 × 안전 여유율`로 필요한 고유 좌석과 허용되는 예약 행 수를 사전에 계산한다. 예를 들어 1,000 RPS를 60분 유지하면 최소 360만 건의 요청 상태가 필요하므로 작은 Fixture를 반복 사용하거나 전체 좌석 배열을 애플리케이션 메모리에 한 번에 만들지 않는다. 배치·bulk seed 또는 실행 목적에 맞는 격리된 대용량 Fixture를 사용하고 생성 시간, DB 용량, Redis 메모리, cleanup 비용을 preflight에 포함한다.

Soak의 인증 토큰 유효 시간은 setup, 본 실행, queue drain, 감사 시간과 안전 여유보다 길어야 한다. 그렇지 않으면 실행 중 안전한 토큰 갱신 절차를 사용하고 갱신 시점과 `401`을 별도 지표로 기록한다. 데이터·토큰 용량을 충족하지 못해 60분보다 짧게 실행한 결과는 Soak로 부르지 않고 장시간 실행 예비 결과로 표시한다.

## 6. 지표 및 통과 기준

### 6.1 k6 지표

- 목표 offered RPS, 실제 시작한 예약 요청 RPS, 서버 enqueue RPS와 완료 응답 RPS
- VU, iteration, `dropped_iterations`
- `201 accepted`, 예상 충돌 `409`, 기타 `4xx`, `5xx`, timeout
- outcome별 p50, p90, p95, p99, max
- connect, TLS, blocked, waiting, receiving 시간
- Check 성공률과 Threshold 통과 여부

### 6.2 서버 지표

- 인스턴스·프로세스별 CPU와 메모리
- Event Loop Lag, GC, PM2 재시작
- Redis latency, ops/sec, 연결, 메모리, eviction
- 예약 큐 현재·최대 길이와 가장 오래된 메시지 나이
- DB active/wait connection, query latency, lock wait, transaction 실패
- 예약 enqueue부터 DB INSERT까지의 영속화 지연
- Redis Lua 결과 `OK`, `FAIL`, `MISS`
- 예약 처리 성공·실패 수

PM2 cluster 지표에는 host, instance, `pm_id`, PID와 worker generation label을 포함한다. Counter는 worker별 값을 합산하되 재시작에 따른 reset을 보정하고, 메모리는 합계와 worker 최댓값을 모두 기록한다. Histogram은 동일 bucket을 합산해 전체 분위수를 다시 계산하며 worker별 p95를 평균내지 않는다. Event Loop Lag과 오류율은 전체 집계와 worker별 최악값을 함께 남겨 특정 worker의 병목이 평균에 가려지지 않게 한다. 모든 발생기와 서버의 시계 동기화 상태도 metadata에 기록한다.

### 6.3 공통 정합성 기준과 1차 SLO 가설

아래 값은 본 실행 전에 확정하며 결과를 확인한 뒤 유리하게 변경하지 않는다.

- 정상 예약 접수 `p95 < 200ms`
- 정상 예약 접수 `p99 < 500ms`
- 예상하지 않은 오류율 `< 0.1%`
- 중복·유실 `0건`
- DB 영속화 지연 `p95 < 2s`
- 부하 종료 후 큐 배출 `< 30s`
- 예약 처리 실패 `0건`

중복·유실과 처리 실패 0건은 정합성 또는 지속 가능 처리량을 주장하기 위한 공통 Gate다. 지연, 오류율, `dropped_iterations`, 회복 시간은 실험 목적별로 적용한다. 제품 요구사항이 따로 정해지면 해당 요구사항을 우선하되 Run 시작 전에 적용 profile과 근거를 고정한다.

### 6.4 실험별 판정

| 실험 | 판정 목적 | PASS 또는 완료 기준 |
| --- | --- | --- |
| Smoke | 실행 기반의 연결 검증 | Setup·필수 Check 100%, 필수 산출물 생성, 예상하지 않은 오류 0건 |
| 단일 좌석·50석·재예약 | 정합성 회귀 | 기대한 접수 수, 접수 ID와 저장 ID 집합 일치, 중복·상태 불일치·DLQ·처리 실패 0건 |
| 변경 전 기준선 | 비교 가능한 증거 확보 | 실행 유효성이 `VALID`이고 필수 지표·산출물이 보존됨. 제품 SLO 판정은 기록하되 기준선 확보 자체와 분리 |
| VU Capacity | 폐쇄형 동시성 변화 관찰 | 사전에 정상 운영 구간으로 정한 단계는 SLO 충족. 그 이후 단계는 실제 RPS, 활성 VU, 포화 징후를 탐색 결과로 기록 |
| RPS 탐색 | 포화점과 붕괴 양상 식별 | 각 단계의 achieved RPS, `dropped_iterations`, 오류, 지연, 큐 증가율이 완전하게 수집되면 탐색 완료. `dropped_iterations > 0` 자체는 Run 실패가 아니라 포화 근거 |
| RPS 확정 | 지속 가능한 처리량 검증 | `dropped_iterations = 0`, 공통 정합성·SLO 충족, 큐가 제한 시간 안에 배출되며 같은 조건을 최소 3회 재현 |
| Spike | 급증 후 회복 검증 | 사전에 고정한 최대 오류·drop 허용치, 정상 지연 복귀 시간, 큐 배출 시간을 충족 |
| Soak | 장시간 안정성 검증 | 공통 정합성·SLO 충족, 재시작·eviction·연결 누수 0건, 메모리와 큐에 지속적인 양의 증가 추세가 없고 종료 후 큐 배출 |

RPS 탐색의 100%·110% 부하처럼 의도적으로 한계를 넘는 구간에는 RPS 확정용 `dropped_iterations = 0`을 적용하지 않는다. 대신 어느 기준이 처음 깨졌는지와 회복 여부를 결과로 남긴다. 실험별 threshold profile은 Run 시작 전에 이름과 해시를 고정한다.

## 7. 결과 저장 계획

각 Run의 `metadata.json`에는 다음 항목을 포함한다.

- Run ID, 시작·종료 시각, 타임존과 실행 단계별 시각
- 실행 상태, 현재·실패 단계, 실패 코드와 사유
- Git commit SHA, dirty 여부, 이미지 tag 또는 digest
- k6·Node.js 버전, 테스트 스크립트·설정·threshold profile 해시
- executor, stages, VU, 목표 RPS, 실제 RPS, duration
- 사용자·토큰·좌석 수, 좌석 배정 방법, 예상·실제 Fixture 크기와 토큰 만료 시각
- Warm/Cold Cache, Tracing On/Off, 로그 수준
- Run namespace, Performance ID, Redis prefix, 큐 이름과 DB 식별자
- k6 발생기 사양·실행 위치·자원 포화 여부와 시계 동기화 상태
- ALB, Nginx, EC2 수와 사양, PM2 worker 수·generation·집계 방식
- RDS와 Redis 사양, DB pool과 max connection
- 로컬·원격 여부와 원격 승인 manifest 해시·scope 대조 결과
- 적용 Threshold, 실행 유효성, 판정과 판정 사유

`metadata.json`과 `report.md`는 preflight 실패를 포함한 모든 실행 시도에 필수다. Setup이 시작됐다면 `fixture-manifest.json`, 부하가 시작됐다면 `summary.json`, 접수 요청이 하나라도 발생했다면 성공·timeout 여부와 관계없이 `consistency-audit.json`을 남긴다. 서버 지표를 요구하는 시나리오는 `server-metrics.json`에 원본 시계열 자체 또는 저장 위치·조회 범위·해시를 기록한다. 조건부 산출물을 만들 수 없으면 생략하지 말고 artifact 상태를 `MISSING`으로 기록하고 사유를 남긴다.

`summary.json`에는 k6 집계 결과를, `consistency-audit.json`에는 pending·processing/in-flight·retry·DLQ, 접수·처리·DB ID 집합 차이와 좌석 검증 결과를, `report.md`에는 결과 해석과 다음 실험 결정을 저장한다. 작은 Run은 ID 목록을 직접 보존할 수 있지만 대규모 Run은 정렬된 ID manifest를 압축 외부 artifact로 저장하고 URI·SHA-256·건수와 누락/초과 표본만 감사 JSON에 남겨 Git artifact가 과도하게 커지지 않게 한다.

### 7.1 공통 결과 스키마

도구가 달라도 최종 보고서는 아래 의미를 유지한다. 값이 수집되지 않았다면 `0`으로 꾸미지 않고 `null`과 누락 사유를 기록한다.

```json
{
  "schemaVersion": "2.0",
  "runId": "20260928-rps-001",
  "startedAt": "2026-09-28T00:00:00Z",
  "endedAt": null,
  "timezone": "Asia/Seoul",
  "execution": {
    "status": "RUNNING",
    "phase": "load",
    "failureCode": null,
    "failureReason": null
  },
  "source": {
    "gitSha": "",
    "gitDirty": null,
    "imageDigest": null,
    "scriptSha256": "",
    "configSha256": "",
    "thresholdProfile": "rps-confirm-v1",
    "thresholdProfileSha256": ""
  },
  "authorization": {
    "remote": false,
    "approvalManifestSha256": null,
    "scopeMatched": null
  },
  "environment": {
    "name": "",
    "appInstances": null,
    "appInstanceType": "",
    "database": "",
    "redis": "",
    "generator": "",
    "generatorSaturated": null,
    "clockSynchronized": null,
    "pm2Aggregation": "sum-counters-merge-histogram-buckets"
  },
  "isolation": {
    "namespace": "",
    "performanceId": null,
    "redisPrefix": "",
    "queueNames": [],
    "cleanupPolicy": "manifest-owned-ids-only"
  },
  "fixture": {
    "manifestPath": "fixture-manifest.json",
    "expectedUsers": null,
    "actualUsers": null,
    "expectedSeats": null,
    "actualSeats": null,
    "expectedRequestStateRows": null,
    "tokenExpiresAt": null
  },
  "scenario": {
    "name": "",
    "purpose": "capacity-confirmation",
    "workloadModel": "closed-vu",
    "executor": "",
    "target": "",
    "duration": "",
    "dataset": ""
  },
  "load": {
    "offeredRps": null,
    "startedReservationRps": null,
    "serverEnqueuedRps": null,
    "completedResponseRps": null,
    "maxVus": null,
    "iterations": null,
    "droppedIterations": null
  },
  "http": {
    "acceptedStatus": null,
    "clientObservedAccepted": null,
    "serverEnqueued": null,
    "expectedConflict409": null,
    "unexpected4xx": null,
    "server5xx": null,
    "timeouts": null,
    "acceptedDurationMs": {
      "p50": null,
      "p95": null,
      "p99": null
    },
    "conflictDurationMs": {
      "p50": null,
      "p95": null,
      "p99": null
    }
  },
  "asyncProcessing": {
    "maxQueueDepth": null,
    "pendingAtAudit": null,
    "inFlightAtAudit": null,
    "retryAtAudit": null,
    "dlqAtAudit": null,
    "p95PersistenceLagMs": null,
    "p99PersistenceLagMs": null,
    "queueDrainMs": null,
    "processedSuccess": null,
    "processedFailure": null
  },
  "consistency": {
    "expectedAccepted": null,
    "acceptedUniqueIds": null,
    "persistedUniqueIds": null,
    "missingAcceptedIds": null,
    "unexpectedPersistedIds": null,
    "duplicateProcessingIds": null,
    "persistedReservations": null,
    "distinctReservedSeats": null,
    "duplicateActiveSeats": null,
    "stateMismatches": null,
    "pass": null
  },
  "thresholds": [],
  "artifactSet": {
    "status": "OPEN",
    "finalizedAt": null
  },
  "artifacts": [
    {
      "path": "metadata.json",
      "required": true,
      "status": "PRESENT",
      "sha256": null,
      "missingReason": null
    }
  ],
  "validity": {
    "status": "INCONCLUSIVE",
    "reasons": []
  },
  "verdict": {
    "kind": "compliance",
    "status": "INCONCLUSIVE",
    "reasons": []
  },
  "notes": []
}
```

`execution.status`는 `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `ABORTED` 중 하나를 사용하고 실패·중단 시 마지막 phase와 구조화된 실패 코드를 함께 기록한다. `artifactSet.status`는 `OPEN`, `FINALIZED`, `INCOMPLETE` 중 하나로 실행 성공 여부와 별개다. 실패한 실행도 실패 보고서와 생성 가능한 artifact의 schema·checksum 검증이 끝나면 artifact set을 `FINALIZED`할 수 있다. `validity.status`는 `VALID`, `INVALID`, `INCONCLUSIVE` 중 하나로 측정 자료가 판정에 적합한지를 나타낸다. `verdict.kind`는 `baseline`, `correctness`, `compliance`, `exploratory`, `recovery`, `endurance` 중 하나이며 `verdict.status`는 `PASS`, `FAIL`, `NOT_APPLICABLE`, `INCONCLUSIVE` 중 하나다. 탐색 실험은 유효한 포화 결과를 얻어도 SLO 합격을 뜻하지 않으므로 보통 `NOT_APPLICABLE`을 사용한다.

수집되지 않은 수치와 아직 끝나지 않은 boolean은 `0`이나 `false`로 초기화하지 않고 `null`로 둔다. 각 artifact에는 상대 경로, 필수 여부, `PRESENT`·`MISSING`·`NOT_APPLICABLE` 상태, SHA-256, 누락 사유를 기록한다. 비밀값과 원문 토큰은 어떤 산출물에도 저장하지 않는다.

## 8. 포트폴리오 변경 계획

### 8.1 새 문서 구조

1. 문제 정의
2. 동시성·비동기 저장 구조
3. 실패 가능성과 계층별 방어선
4. 테스트 방법과 실행 환경
5. 정합성 결과
6. VU 기반 동시 사용자 결과
7. RPS 기반 지속 처리량 결과
8. 병목 분석과 개선 전후 비교
9. 한계, 실패 실험, 후속 과제
10. 원본 Run ID와 결과 링크

### 8.2 즉시 수정할 표현

- 새 RPS 실험 전까지 `3,000 RPS 달성` 표현을 사용하지 않는다.
- `201 성공`을 `예약 접수 성공`으로 표현한다.
- DB 감사가 없는 결과에는 `정합성 100% 보장`을 사용하지 않는다.
- 인증 전후 A/B 자료가 없는 `DB Read 90% 감소`는 측정 조건을 추가하거나 보류한다.
- `2,000 VU`와 `N RPS`를 서로 다른 실험 결과로 기록한다.

### 8.3 최종 성과 문장 형식

- “1,000 VU가 각각 한 번씩 50개 좌석에 균등하게 요청한 결과, 정확히 50건이 접수·영속화됐으며 중복 예약은 0건이었다.”
- “폐쇄형 부하 모델에서 최대 2,000 VU까지 응답시간과 서버 자원 변화를 검증했다.”
- “개방형 부하 모델에서 dropped iteration 없이 성능 기준을 만족한 최대 지속 가능 처리량은 N RPS였다.”
- “최대 부하 종료 후 pending·in-flight·retry queue는 N초 안에 최종 상태에 도달했으며 접수 ID와 DB 저장 ID 집합이 일치했다.”

`N`은 새 결과가 나오기 전까지 채우지 않는다.

개선 전후 수치는 같은 시나리오, 인프라, Fixture, 캐시·tracing 상태와 threshold profile로 실행한 유효한 기준선·변경 후 Run 쌍이 있을 때만 사용한다. 하나라도 다르면 절대 개선율 대신 각 실행 조건과 관측값을 나란히 제시한다.

### 8.4 추적 및 전달 정책

- 계획·방법론·요약 보고서가 별도 작업 환경에서도 보이도록 Git 추적 여부를 확인한다.
- 실제 포트폴리오 원본 경로가 `.gitignore` 대상이라면 무시 규칙을 임의로 우회하지 않는다. 원본을 추적할지, 추적 가능한 `PORTFOLIO_UPDATE.md`에 반영안을 남길지 먼저 결정한다.
- 외부에만 보관하는 원본 결과도 Run ID, URI, 접근 범위와 SHA-256을 추적 가능한 보고서에 남긴다.

## 9. 단계별 실행과 Gate

Gate의 검증 수준은 다음처럼 구분한다.

- `STATIC_VERIFIED`: 문법, 설정, schema와 dry-run 검사가 통과했다. 실제 앱·DB·Redis 연동 성공을 의미하지 않는다.
- `INTEGRATION_VERIFIED`: 격리된 앱·DB·Redis에서 실제 요청, 비동기 처리와 감사까지 통과했다.
- `REMOTE_VERIFIED`: 승인 manifest 범위의 격리 원격 환경에서 실험별 판정, 자동 중단 감시, 사후 감사와 안전한 cleanup까지 완료했다.

정적 inspect 결과만으로 `INTEGRATION_VERIFIED`나 다음 부하 단계 Gate를 통과시킬 수 없다.

실행 문서 단계와 Phase의 대응은 다음과 같다.

| Phase | 실행 단계 |
| --- | --- |
| Phase -1 | 0단계 레거시 원격 실행 격리 |
| Phase 0 | 1단계 사실 감사 |
| Phase 1 | 2~3단계 공통 기반·결과/감사 구축 |
| Phase 2 | 1~3단계에서 기준선 revision 고정, 12단계에서 실제 기준선 실행 |
| Phase 3 | 4~7단계 오류 계약·정합성·재예약·큐 내구성 |
| Phase 4 | 8단계 관측성 |
| Phase 5 | 9~12단계 시나리오 구현·승인 실행 |
| Phase 6 | 13단계 결과·포트폴리오 반영 |

### Phase -1. 레거시 원격 실행 안전 격리

- 기존 k6 진입점과 문서에 남은 고정·기본 원격 주소를 전수 확인한다.
- 명시적인 대상이 없으면 로컬 안전 기본값만 사용하거나 실행을 중단하고, 레거시 스크립트에는 Deprecated 경고와 원격 차단을 적용한다.
- runner가 원격 승인 manifest의 host, 최대 VU·RPS, 지속 시간과 만료 시각을 실제 인자와 대조하도록 한다.
- Gate (`STATIC_VERIFIED`): 모든 진입점이 승인 없이 원격 목적지를 선택할 수 없고, 대상·허용 범위 불일치 시 preflight에서 부하 시작 전에 종료되어야 한다.

### Phase 0. 사실관계 고정

- 현재 코드·문서·테스트 주장을 연결한 감사 문서를 만든다.
- 검증되지 않은 수치와 표현을 식별한다.
- 현재 애플리케이션 Git SHA와 설정을 고정하고 이후 변경 목록의 시작점을 남긴다.
- Gate (`STATIC_VERIFIED`): 모든 기존 성과 수치에 출처 또는 보류 상태가 표시되고 기준선 후보 코드가 식별되어야 한다.

### Phase 1. 격리된 테스트 기반 구축

- 공통 설정, Run namespace, 상태 기반 Fixture, `k6/results/<run-id>/` 결과 저장, DB·큐·ID 집합 감사 도구를 만든다.
- 애플리케이션 계약을 바꾸지 않고 현재 응답과 로그를 분류할 수 있는 기준선용 outcome mapping을 만든다.
- 기준선 비교에 필요한 최소 서버 지표와 PM2 worker label을 준비한다.
- manifest 소유 ID만 삭제하는 cleanup과 실패 산출물 저장을 구현한다.
- Gate (`INTEGRATION_VERIFIED`): 격리된 로컬 앱·DB·Redis에서 Smoke가 통과하고 필수·조건부 결과 파일, queue 처리 완료와 감사 결과가 실제로 생성되어야 한다.

### Phase 2. 변경 전 기준선 revision 보존

- 애플리케이션의 정합성·내구성·성능 동작을 바꾸기 전에 기준선 Git SHA, dirty 상태, 배포 가능한 이미지 digest, migration과 기존 API outcome mapping을 보존한다.
- 실제 기준선 Run은 공통 runner가 완성된 뒤 Phase 5에서 이 revision을 재배포해 후보와 동일 조건으로 실행한다.
- Gate (`STATIC_VERIFIED`): 기준선 revision과 이미지가 재현 가능하고 이후 후보 변경과 분리되어야 한다. Phase 5에서 유효한 기준선 Run을 만들지 못하면 개선율 주장은 금지한다.

### Phase 3. 정합성 및 내구성

- 구조화된 오류 코드 계약을 먼저 확정해 예상 충돌과 Redis·Queue·DB 장애를 구분한다.
- 단일 좌석, 50석 경쟁, 재예약, processing/in-flight·retry·DLQ를 포함한 queue 처리 완료 검증을 구현한다.
- 접수 ID와 처리·DB ID를 연결하고 확인된 재예약·큐 유실 경로를 수정한다.
- Gate (`INTEGRATION_VERIFIED`): 접수·처리·DB ID 집합이 일치하고 중복·유실·DLQ·처리 실패가 0건이어야 하며 재예약 회귀 테스트가 실제 DB 저장까지 통과해야 한다.
- `NO_GO`: 이 Gate가 실패하면 처리량 qualification, Spike·Soak, 개선 성과와 포트폴리오 정합성 문장을 만들지 않는다. 원인 규명을 위한 별도 승인·저부하 진단 Run만 `NON_QUALIFYING`으로 허용하며 성능 성과 근거로 사용하지 않는다.

### Phase 4. 관측성 완성

- 큐 길이, processing/in-flight, retry, DLQ, 메시지 나이, 영속화 지연과 처리 실패 지표를 추가한다.
- PM2 worker별 label, 재시작 보정, counter 합산과 histogram bucket 병합 규칙을 적용한다.
- Gate (`INTEGRATION_VERIFIED`): Smoke 부하 중 k6, 각 PM2 worker, Redis와 DB 지표를 동기화된 같은 시간 범위로 조회할 수 있고 필수 metric 누락이 없어야 한다.

### Phase 5. 승인된 성능 실행

- Fixture·토큰·저장 용량 preflight를 통과한 뒤 VU, RPS 탐색·확정, Spike, Soak 순으로 실행한다.
- 원격 환경에서는 Phase -1의 유효한 승인 manifest와 격리된 비운영 대상을 다시 검증한다.
- RPS 탐색은 포화 근거를 남기고, RPS 확정은 기준을 충족한 동일 조건을 최소 3회 재현한다.
- Gate (`REMOTE_VERIFIED`): 발생기가 포화되지 않았고 필수 산출물이 보존되며 각 Run이 6.4의 목적별 판정을 가져야 한다. 기준선과 비교하는 결과는 환경·Fixture·설정이 일치해야 한다.

### Phase 6. 포트폴리오 반영

- 원본 결과에서 자동 또는 수동으로 결과표와 근거 문장을 작성한다.
- 실패·한계 실험과 측정하지 못한 항목도 함께 표시한다.
- Gate: 모든 수치가 유효한 Run ID, 실행 조건, 원본 파일과 artifact 해시로 추적되고 무시 파일에만 변경이 남지 않아야 한다.

## 10. 전체 완료 기준

- 문서만 보고 다른 사람이 동일 테스트를 재실행할 수 있다.
- VU와 RPS 결과가 분리되어 있다.
- 정상 예약과 예상 충돌의 지연이 분리되어 있다.
- 승인 없이 레거시 스크립트가 원격 대상에 부하를 보낼 수 없다.
- HTTP 201과 최종 DB 저장 건수뿐 아니라 접수·처리·DB ID 집합이 자동 대조된다.
- pending, processing/in-flight, retry, DLQ, 중복, 유실과 처리 실패가 자동 검증된다.
- 모든 결과에 코드·스크립트·인프라 버전이 기록된다.
- 상태 누적형 실험의 Fixture 용량과 토큰 수명이 실행 시간 전체를 감당한다.
- PM2 다중 worker 지표가 정해진 집계 규칙으로 저장된다.
- 개선율은 동일 조건의 유효한 변경 전·후 Run 쌍으로만 계산된다.
- 실행 실패와 artifact 누락도 구조화된 상태와 사유로 기록된다.
- 모든 산출물이 `k6/results/<run-id>/`에서 추적된다.
- 포트폴리오의 모든 성능 수치가 특정 Run ID와 연결된다.
- 검증되지 않은 항목과 실패 결과도 숨기지 않고 한계로 기록한다.
