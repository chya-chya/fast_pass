# 7단계 큐 내구성 검증

## 판정

**`INTEGRATION_VERIFIED` — readiness 보강 후 clean commit 재검증 완료**

예약 큐를 Redis list의 단일 `LMOVE` claim 방식에서 Redis Streams consumer group 기반 at-least-once delivery로 전환했다. worker가 DB 처리 도중 종료되면 메시지는 consumer group의 pending entries list(PEL)에 남고, 다른 worker가 설정된 idle 시간 뒤 `XAUTOCLAIM`으로 회수한다.

DB commit 후 `XACK` 전에 worker가 종료되어 같은 메시지가 다시 전달되더라도 producer가 만든 reservation ID를 유지한다. consumer는 해당 ID의 DB 행을 먼저 확인하고 user, seat, reserved time이 같으면 이미 완료된 작업으로 화해한 뒤 ack한다. 같은 ID에 다른 payload가 연결된 경우에는 `IDEMPOTENCY_CONFLICT`로 격리한다.

2026-10-07에 전용 일회성 PostgreSQL·Redis에서 실패 주입 테스트 8건, 재예약 회귀 2건, 실제 앱 Smoke와 사후 ID 감사를 모두 다시 통과했다. 실제 앱 검증은 매 작업 전 legacy backlog 재검사가 포함된 clean commit `564b2bc`에서 실행했으므로 7단계의 메시지 복구·중복 처리 Gate를 충족한다.

## 구현된 delivery semantics

```text
producer: XADD {queue:reservations}:stream:v1
consumer: XREADGROUP reservation-workers-v1 <unique-consumer> ... >
recovery: XAUTOCLAIM after RESERVATION_RECLAIM_IDLE_MS
active claim: heartbeat + commit 직전 owner 확인
success: DB commit/reconcile -> owner-fenced XACK + XDEL
transient failure: PEL 유지 -> stale claim으로 재전달
permanent/max-delivery failure: owner-fenced DLQ XADD -> source XACK + XDEL
```

- 기본 stale claim 기준: `RESERVATION_RECLAIM_IDLE_MS=30000`
- 기본 최대 delivery: `RESERVATION_MAX_DELIVERIES=3`
- consumer 이름: host, PM2 instance, PID, 난수 suffix 조합
- DLQ 필드: source stream ID, reservation ID, delivery count, failure code, 원본 payload
- terminal marker: reservation ID와 source stream ID 조합별 성공·실패 결정을 ACK까지 보존하고, `XACK`·`XDEL`과 같은 Lua 작업에서 삭제해 crash recovery와 정상 처리 시 key 정리를 함께 보장한다.
- terminal 생성과 ACK는 같은 Lua 작업 안에서 PEL owner를 확인한다. 이미 다른 consumer가 회수한 메시지는 이전 worker가 종결하거나 삭제할 수 없다.
- poison payload, 없는 좌석, 활성 좌석 충돌, reservation ID/payload 불일치는 재시도하지 않는다.
- 일반 DB 오류는 PEL에 남겨 제한 횟수만큼 다시 전달하고, 한도를 넘으면 DLQ로 이동한다.
- transaction 오류 뒤 reservation ID 화해 조회도 실패해 commit 결과를 알 수 없는 경우에는 `OUTCOME_UNKNOWN`으로 분류한다. 이 상태는 delivery 한도를 넘겨도 ACK/DLQ하지 않고, DB 결과를 확인할 수 있을 때까지 PEL에 보존한다.

`XACK`와 PostgreSQL commit은 하나의 분산 transaction으로 묶지 않는다. 대신 DB commit을 먼저 수행하고 reservation ID 기반 idempotency로 commit-after-crash 구간을 정상 복구 경로로 만든다. 따라서 delivery는 exactly-once가 아니라 **at-least-once delivery + idempotent database effect**다.

## 장애 주입 통합 검증

- 테스트: `src/reservation/reservation.queue-durability.integration.spec.ts`
- 실행: `RUN_QUEUE_DURABILITY_INTEGRATION=true k6/tools/run-local-integration.sh smoke`
- 환경: 실행마다 새로 생성한 loopback 전용 PostgreSQL·Redis, tmpfs 데이터, 종료 시 컨테이너·볼륨 삭제
- 결과: **8/8 통과**, 종료 코드 0

| 시나리오                 | 확인 결과                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| 일시적 DB 실패           | 1·2번째 delivery 실패 후 PEL 유지, 3번째 delivery에서 DB 1건 저장 및 성공 ack                        |
| DB 처리 전 worker 유실   | 원 worker의 stale PEL 항목을 다른 consumer가 `XAUTOCLAIM`하고 DB 1건 저장                            |
| DB commit 후 worker 유실 | 재전달 consumer가 동일 reservation ID의 행을 화해하고 중복 insert 없이 성공 ack                      |
| 최대 delivery 초과       | 3번째 실패에서 delivery count와 오류 코드를 포함해 DLQ 이동                                          |
| poison message           | 첫 delivery에서 `POISON_MESSAGE` DLQ 이동, DB 접근 없음                                              |
| 복수 worker reclaim 경쟁 | 3개 consumer가 동시에 회수해도 동일 stream ID를 한 consumer만 획득                                   |
| stale worker 종결 경쟁   | 다른 consumer가 회수한 뒤에는 이전 worker의 terminal 생성·ACK가 거부됨                               |
| ID 보존                  | accepted IDs가 processed-success와 terminal-failure의 합집합과 정확히 일치하고 DB에는 성공 ID만 존재 |

재예약 통합 테스트도 같은 방식의 disposable 환경에서 **2/2 통과**했다. 취소 또는 만료 뒤 같은 좌석을 새 reservation ID로 다시 예약할 수 있고, 활성 예약은 좌석당 한 건만 유지됐다.

## 실제 앱 Smoke와 ID 감사

- Run ID: `local-smoke-20261007070710-98014`
- 소스: `564b2bc5ea93a64b54b11d964db81a46e4e6eea7`, `gitDirty=false`
- 실행: `k6/tools/run-local-integration.sh smoke`
- 상태: `execution=COMPLETED`, `artifactSet=FINALIZED`, `preflight=VERIFIED`
- 감사 판정: `PASS`, reasons 없음
- accepted / processed / DB persisted: `1 / 1 / 1`, 동일 reservation ID
- pending / processing / retry / DLQ: `0 / 0 / 0 / 0`
- worker in-flight: `0`
- conservation difference: `0`
- drain: `1,064ms`
- 증거: `k6/results/local-smoke-20261007070710-98014/`

감사기는 stream consumer group의 `lag`를 pending으로, PEL 수를 processing으로, delivery count가 2 이상인 PEL 항목을 retry로 읽는다. 따라서 새 메시지가 모두 claim됐더라도 PEL 또는 run별 worker in-flight가 남아 있으면 drain 완료로 판정하지 않는다. `k6/tests/audit.test.js`도 pending=0인 경우를 포함해 processing, retry, worker in-flight 중 하나라도 남으면 `isDrainCandidate()`가 false임을 검증한다.

## ID 단위 보존 법칙

완료된 Run은 다음 집합 법칙을 만족해야 한다.

```text
accepted IDs = processed-success IDs ∪ terminal-failure IDs
processed-success IDs = DB persisted IDs
processed-success IDs ∩ terminal-failure IDs = ∅
stream lag IDs ∪ PEL IDs = ∅  (drain 완료 시점)
duplicate DB IDs와 unexpected DB IDs = ∅
```

성공 Smoke Run에서는 다음과 같이 수렴했다.

```text
accepted/enqueued = {2ac53539-ac7d-4532-b9e1-66a9ca815578}
processed-success = {2ac53539-ac7d-4532-b9e1-66a9ca815578}
DB persisted = {2ac53539-ac7d-4532-b9e1-66a9ca815578}
terminal-failure/DLQ/PEL = {}
```

## 운영 경계와 migration

- Redis 6.2 이상이 필수다. 앱은 시작 시 비파괴 `COMMAND INFO XAUTOCLAIM` 검사로 기능 지원 여부를 확인하고, 지원하지 않으면 producer와 worker 모두 준비되지 않은 상태로 종료한다. 로컬 Compose는 Redis 7을 사용한다.
- reclaim idle 값은 정상 DB transaction의 상한보다 충분히 길게 설정해야 한다. 지나치게 짧으면 살아 있는 느린 worker의 항목을 다른 worker가 조기에 회수할 수 있다. reservation ID idempotency가 DB 중복은 막지만 불필요한 동시 작업은 발생할 수 있다.
- stream trim 정책은 아직 자동 적용하지 않는다. 성공 항목은 ack와 함께 `XDEL`하고 DLQ는 운영자가 원인을 확인할 수 있도록 별도 stream에 유지한다.
- 배포 전에 기존 producer와 worker를 모두 중지하고 `queue:reservations`, `{queue:reservations}:processing`, `{queue:reservations}:retry`, `{queue:reservations}:dlq`를 완전히 drain한다. 앱은 네 list 중 하나라도 남아 있으면 시작과 신규 enqueue/claim을 거부한다.
- legacy list consumer와 stream consumer를 동시에 활성화하거나 무중단 dual-write하지 않는다. rolling mixed-version 배포도 지원하지 않는다. 기존 producer/worker 중지 → legacy queue drain 확인 → 신규 버전 시작 순서로 전환한다.
- 운영 데이터 migration과 원격 장애 주입은 이번 단계에서 수행하지 않았다.

## 검증 결과

- `git diff --check`: 통과
- `npm run build`: 통과
- tracker/service focused Jest: 40/40 통과
- queue durability disposable integration: 8/8 통과
- rebooking disposable integration: 2/2 통과
- 실제 앱 Smoke + artifact finalize + ID audit: clean commit `564b2bc`에서 통과
- reservation 전체 Jest: 55개 통과, 10개 조건부 통합 테스트 skip
- queue drain/ID audit Node test: 38/38 통과
- Compose 설정 및 shell/JavaScript 문법 검사: 통과
