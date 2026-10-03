# 7단계 큐 내구성 검증

## 판정

**`NO_GO`**

현재 구현은 프로세스가 살아 있는 동안 발생한 DB transaction 실패를 DLQ에 보존한다. 그러나 `LMOVE`로 메시지를 `processing` list에 옮긴 뒤 worker가 종료되면 다른 worker가 해당 메시지를 다시 가져갈 방법이 없다. 재시도 한도, stale claim 회수, 자동 requeue도 구현되어 있지 않다.

따라서 물리적으로 Redis에 payload가 남아 있는 것과 처리 복구가 가능한 것은 구분해야 한다. 현재 delivery semantics는 표준적인 at-least-once가 아니라 **pending queue 관점의 단일 claim + best-effort 완료 기록**이다. worker 장애 시 accepted 작업이 `processing`에 무기한 고립될 수 있으므로 end-to-end no-loss 또는 장애 복구를 주장할 수 없다.

처리량 qualification, Spike·Soak, 개선 성과와 포트폴리오 정합성 문장은 이 `NO_GO`를 해제하기 전까지 차단한다. 결함 분석 목적의 실행만 별도 승인된 격리 환경에서 `NON_QUALIFYING`으로 허용한다.

## 검증 환경과 방법

- 실행일: 2026-10-02
- 환경: 실행마다 새로 만든 로컬 disposable PostgreSQL·Redis
- 테스트: `src/reservation/reservation.queue-durability.integration.spec.ts`
- 실행 경로: `RUN_QUEUE_DURABILITY_INTEGRATION=true k6/tools/run-local-integration.sh smoke`
- 원격 Redis·DB 및 공유 데이터: 사용하지 않음
- 결과: Jest 2건 통과, 프로세스 종료 코드 0

통합 테스트는 실제 Redis list와 실제 PostgreSQL의 Reservation 행을 조회하되 DB transaction 동작만 결정적으로 실패하거나 대기하도록 주입한다. 별도 audit 연결로 해당 reservation ID가 DB에 저장되지 않았음도 확인한다.

## 재현 결과

| 시나리오 | pending | processing | retry | DLQ | 처리 counter | DB | 결론 |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| enqueue 직후 | 1 | 0 | 0 | 0 | enqueue=1 | 0 | accepted payload 존재 |
| DB transaction 강제 실패 후 | 0 | 0 | 0 | 1 | started=1, failure=1, in-flight=0 | 0 | payload는 DLQ에 보존되지만 재시도 없음 |
| DB transaction 대기 중 | 0 | 1 | 0 | 0 | started=1, in-flight=1 | 0 | pending만 보면 잘못 drain 완료로 볼 수 있는 상태 |
| 위 상태에서 다른 worker claim | 0 | 1 | 0 | 0 | 변화 없음 | 0 | `claimNext()`는 null, 회수 불가 |

두 번째 테스트는 종료 가능한 테스트를 만들기 위해 관찰을 마친 뒤 대기 중 transaction을 실패시켜 정리한다. 실제 프로세스가 그 전에 종료되면 `markFailure()`가 호출되지 않으므로 payload는 DLQ가 아니라 `processing` list에 그대로 남는다.

`k6/tests/audit.test.js`는 producer 완료 및 `pending=0`만으로 drain을 인정하지 않는다. `processing`, `retry`, `workerInFlight` 중 하나라도 0이 아니면 `isDrainCandidate()`가 false임을 각각 검증한다. 즉 현재 감사기는 관측 가능한 고립 상태를 성공으로 오판하지 않지만, 소비자는 그 상태를 복구하지 못한다.

## ID 단위 보존 법칙

완료 가능한 Run은 다음 집합 법칙을 만족해야 한다.

```text
accepted IDs = processed-success IDs ∪ terminal-failure IDs
processed-success IDs = DB persisted IDs
processed-success IDs ∩ terminal-failure IDs = ∅
pending IDs ∪ processing IDs ∪ retry IDs = ∅  (drain 완료 시점)
duplicate delivery IDs와 unexpected DB IDs = ∅
```

DB 실패 재현에서는 단일 ID에 대해 다음이 확인됐다.

```text
accepted/enqueued = {id}
processed-success = {}
terminal-failure/DLQ = {id}
DB persisted = {}
```

프로세스 종료 경계에서는 다음 상태가 남는다.

```text
accepted/enqueued = {id}
processing = {id}
processed-success = {}
retry/DLQ = {}
DB persisted = {}
```

두 번째 상태는 payload의 물리적 삭제는 아니지만 최종 결과 집합으로 수렴하지 않으며, 현재 구현에는 이를 바꾸는 전이가 없다. 이것이 `NO_GO`의 직접 근거다.

## 추가 장애 경계

- DB commit 전 worker 종료: transaction은 rollback될 수 있지만 claim은 `processing`에 고립된다.
- DB commit 후 `markSuccess()` 전 worker 종료: DB에는 행이 있고 `processing`에도 payload가 남는다. 이후 재전송을 추가할 경우 중복 delivery가 발생하므로 consumer idempotency가 필수다.
- `markFailure()` 수행 중 Redis 오류: 실패 ID, counter, DLQ 이동이 모두 하나의 Redis transaction에 묶여 있으나 호출 자체가 실패하면 processing payload만 남을 수 있다. 현재 reclaimer는 없다.
- 일시적 DB 오류: 현재는 첫 오류를 즉시 `PROCESSING_ERROR` DLQ로 보내고 scheduler batch를 중단한다. transient retry와 backoff가 없다.
- poison message: JSON parse 오류도 DLQ로 이동하지만 원인별 재시도 가능성이나 최대 delivery 정책이 없다.
- 다중 PM2 worker: 각 worker는 새 pending 항목만 claim한다. 다른 worker가 남긴 stale processing 항목의 소유자, lease, heartbeat 또는 회수 규칙이 없다.

## 복구 설계 비교

| 설계 | delivery 및 복구 | 장점 | 위험·비용 | 판단 |
| --- | --- | --- | --- | --- |
| Redis Streams consumer group | `XREADGROUP`으로 claim하고 DB commit 및 결과 기록 후 `XACK`; `XPENDING`/`XAUTOCLAIM`으로 stale 항목 회수 | pending ownership와 idle time이 내장되어 다중 worker 복구가 명확함 | producer·consumer·감사·migration 변경이 가장 큼; trim과 consumer 관리 필요 | **추천** |
| List processing + lease/reclaimer | 현재 `LMOVE`를 유지하고 claim 시각·owner·attempt를 저장해 stale 항목을 원자적으로 requeue | producer 변경이 비교적 작고 기존 payload를 활용 가능 | lease, clock, scanner 경쟁, 원자성, orphan cleanup을 직접 설계·검증해야 함 | 차선 |
| 기존 list + scheduler 보상 | processing을 주기적으로 훑어 단순 재삽입 | 변경량이 가장 작음 | 처리 중 항목과 죽은 항목을 구분할 lease가 없으면 중복·조기 회수 가능; 정확한 다중 worker 보장이 어려움 | 권장하지 않음 |

### 추천안의 의미

Redis Streams consumer group을 사용해 **at-least-once delivery**를 명시적으로 채택한다. 장애 복구 시 중복 delivery는 정상적으로 발생할 수 있으므로 다음 조건이 함께 필요하다.

1. reservation ID를 producer에서 한 번만 만들고 모든 재전송에서 유지한다.
2. DB transaction은 reservation ID 기반 idempotency를 보장한다. 동일 ID가 이미 commit된 경우 성공 완료로 화해(reconcile)하고, 다른 ID의 활성 좌석 충돌과 구분한다.
3. `XACK`는 DB commit과 Run별 성공 기록이 확인된 뒤 수행한다. 둘을 단일 원자 transaction으로 묶을 수 없으므로 재처리와 reconciliation을 정상 경로로 설계한다.
4. transient DB/Redis 오류는 지수 backoff와 jitter로 제한 재시도한다. permanent domain rejection과 payload validation 오류는 재시도하지 않는다.
5. 최대 delivery 횟수 초과 또는 poison message는 원본 stream ID, reservation ID, 시도 횟수, 마지막 오류 코드와 함께 DLQ stream으로 옮기고 원본을 ack한다.
6. consumer 이름은 host/PM2 instance/process를 구분하고, reclaimer는 최소 idle time 뒤에만 `XAUTOCLAIM`한다. 여러 reclaimer가 동시에 동작해도 ID 기반 idempotency로 안전해야 한다.
7. Run 감사는 accepted, stream-enqueued, pending, claimed/retried, acked-success, DLQ, DB ID 집합을 직접 대조한다.

## 예상 변경 범위와 migration

승인 시 예상 범위는 queue abstraction과 tracker, `processNextReservation()`, scheduler/reclaimer, 설정, Run 감사, 통합 테스트 및 운영 문서다. 예약 HTTP 계약은 유지하되 내부 enqueue 결과와 오류 분류는 회귀 검증한다.

안전한 migration 기본안은 versioned stream을 만든 뒤 다음 순서로 진행한다.

1. 기존 list의 pending·processing·DLQ ID manifest를 저장하고 신규 enqueue를 짧게 중지한다.
2. 정상 drain 가능한 항목을 처리하고, stale processing은 승인된 migration 도구로 reservation ID를 유지해 stream에 한 번만 옮긴다.
3. producer와 consumer를 같은 배포에서 stream으로 전환한다.
4. accepted/legacy/stream/DB ID 집합을 대조한 뒤 legacy consumer를 종료한다.
5. rollback 시에도 같은 reservation ID를 유지하고 양쪽 consumer를 동시에 활성화하지 않는다.

무중단 dual-write는 부분 성공 시 두 queue의 불일치와 중복을 만들기 쉬워 기본안으로 선택하지 않는다. 무중단 전환이 필수라면 versioned outbox 또는 별도 migration coordinator를 먼저 설계해야 한다.

## `NO_GO` 해제 조건

구조 변경은 아직 구현하지 않았다. 사용자 승인 뒤 아래 격리 통합 검증과 3단계 ID 감사를 모두 통과해야만 `INTEGRATION_VERIFIED`로 바꾸고 `NO_GO`를 해제한다.

- transient DB 실패 후 제한 재시도와 최종 성공
- DB 처리 중 worker 강제 종료 후 다른 worker의 stale claim 회수
- DB commit 직후 worker 종료 및 중복 delivery의 idempotent 성공 처리
- 최대 retry 초과의 DLQ 이동
- 잘못된 payload/poison message 격리
- 복수 PM2 worker의 claim·reclaim 경쟁
- accepted/enqueued/processed/retry/DLQ/DB ID 보존 법칙
- pending=0이지만 processing/in-flight가 남은 상태의 drain 거부

## 검증 결과

- `git diff --check`: 통과
- `npm run build`: 통과
- queue durability disposable integration: 2/2 통과
- queue drain/ID audit Node test: 6/6 통과
- lifecycle, service contract, tracker Jest 회귀: 15/15 통과
- HTTP API contract Jest 회귀: 12/12 통과
- runner shell 문법 검사: 통과

참고로 `src/reservation` 전체 패턴을 한 번에 실행하면 이번 단계에서 수정하지 않은 기본 scaffold 테스트 두 개가 의존성 mock을 제공하지 않아 실패하고, 기존 concurrency integration test도 누적된 `TestRunTrackerService` 의존성을 test module에 등록하지 않아 시작 전에 실패한다. 7단계 관련 회귀는 위의 명시적 대상과 disposable integration에서 분리 검증했다. 이 기존 테스트 구성 부채 역시 숨기지 않지만, 현재 `NO_GO`의 직접 원인은 worker-loss 복구 부재다.
