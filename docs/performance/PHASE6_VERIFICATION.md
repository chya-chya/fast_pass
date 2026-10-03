# 6단계 검증 기록

## 판정

- 실행일: 2026-10-02
- 최종 상태: `INTEGRATION_VERIFIED`
- 검증 범위: 예약 접수·DB 저장→취소 또는 만료→좌석 복구→동일 좌석 재예약→두 번째 DB 저장
- 원격 DB migration 및 원격 요청: 실행하지 않음

전용 일회성 앱·PostgreSQL·Redis에서 서버 통합 테스트와 k6 rebooking Run을 수행했다. 최초 예약과 재예약의 서로 다른 ID가 모두 queue 처리와 DB 영속화까지 일치했고, 취소 이력은 보존하면서 같은 좌석의 활성 예약은 정확히 1건만 존재했다.

## 재현된 실패

수정 전 스키마는 `Reservation.seatId @unique`였다. 첫 예약을 처리하고 취소하면 Reservation 행은 `CANCELLED`로 남고 Seat는 `AVAILABLE`로 복구됐다. 두 번째 HTTP 접수까지는 성공했지만 queue consumer의 두 번째 `Reservation` INSERT가 `Reservation_seatId_key`에 막혀 `processNextReservation()`이 `false`를 반환했다.

이 실패는 스키마를 변경하기 전에 전용 PostgreSQL·Redis 서버 통합 테스트로 재현했다. 따라서 결함은 Redis 좌석 복구가 아니라 전체 이력에 적용된 DB unique 제약이었다.

## 선택한 데이터 불변식

1. `CANCELLED` 예약은 감사와 사용자 이력을 위해 삭제하지 않는다.
2. 한 좌석에는 `PENDING` 또는 `CONFIRMED` 상태의 활성 예약이 최대 1건만 존재할 수 있다.
3. 한 좌석에 여러 `CANCELLED` 이력이 존재할 수 있다.
4. 취소·만료는 Reservation을 `CANCELLED`, Seat를 `AVAILABLE`로 같은 DB transaction에서 전환한다.
5. 새 예약은 별도 ID로 생성되며 기존 취소 행을 재사용하거나 덮어쓰지 않는다.
6. Redis·DB·queue 오류는 정상 좌석 충돌로 변환하지 않는다.

## 스키마와 migration

Prisma relation을 `Seat.reservation` 일대일에서 `Seat.reservations` 일대다로 변경하고 `Reservation.seatId @unique`를 제거했다. 단순 제거로 끝내지 않고 PostgreSQL partial unique index를 추가했다.

```sql
DROP INDEX "Reservation_seatId_key";

CREATE UNIQUE INDEX "Reservation_active_seat_key"
ON "Reservation"("seatId")
WHERE "status" IN ('PENDING', 'CONFIRMED');
```

Migration은 기존 행을 수정하거나 삭제하지 않는다. 기존 unique 제약 아래에서는 좌석별 행이 최대 1개였으므로 새 partial index 생성 시 기존 데이터 충돌도 없다. migration은 전용 일회성 DB에서만 적용했으며 원격 DB에는 적용하지 않았다.

## 서비스와 권한 변경

- 취소는 예약 소유자 ID를 서비스까지 전달해 다른 사용자의 예약을 변경하지 못하게 한다. 소유자가 아니면 존재 여부를 구분해 노출하지 않고 404로 처리한다.
- 예약 ID는 허용 문자와 최대 길이를 검사한 뒤 Prisma query에 전달한다.
- 취소와 확정 상태 변경은 `status=PENDING` 조건의 `updateMany`로 경쟁을 방어한다.
- 취소 시 Seat가 실제 `HELD`일 때만 `AVAILABLE`로 복구한다.
- Redis 상태 갱신은 DB transaction 완료 후 await하며 실패를 숨기지 않는다.
- 만료 scheduler는 사용자 요청용 취소 API를 우회하지 않고 같은 내부 release 상태 전이를 재사용한다.
- 확정도 소유권을 확인하고 DB commit 뒤 Redis를 `OCCUPIED`로 동기화한다.

## rebooking 시나리오와 감사

`k6/scenarios/rebooking.js`는 공통 config, fixture, API, metric, summary, runner와 artifact 봉인 규칙을 재사용한다. 1 VU가 한 iteration 안에서 다음을 수행한다.

1. `<run-id>-req-first`로 최초 예약을 접수한다.
2. scheduler의 DB 영속화를 기다리며 인증된 취소 API를 제한 횟수만 재시도한다.
3. 최초 예약이 `CANCELLED`가 된 뒤 같은 좌석을 `<run-id>-req-second`로 재예약한다.
4. producer 종료 후 queue drain과 DB 감사를 수행한다.

통과 조건은 accepted 2건, first/second accepted 각각 1건, conflict·unexpected error·timeout 0, 서로 다른 예약 ID, 첫 행 `CANCELLED`, 두 번째 행 `PENDING` 또는 `CONFIRMED`, 활성 예약 1건, 최종 Seat와 Redis 상태 `HELD`다.

## 검증 결과

### 서버 통합 테스트

전용 DB·Redis에서 다음 두 테스트가 통과했다.

- 취소 후 동일 좌석 재예약과 두 번째 DB 저장
- 만료 후 동일 좌석 재예약과 두 번째 DB 저장

추가로 한 좌석에 `CANCELLED` 이력 2건과 활성 `PENDING` 1건을 보존했고, 활성 `PENDING`을 직접 하나 더 INSERT하면 partial unique index가 거부하는 것을 확인했다.

### k6 격리 Run

- Run ID: `local-rebooking-20261002100107-80347`
- 상태: `execution=COMPLETED`, `artifactSet=FINALIZED`, preflight·threshold·감사 PASS
- 요청/접수/처리/DB 저장: 2 / 2 / 2 / 2
- 최초 상태: `CANCELLED`
- 두 번째 상태: `PENDING`
- 이력/활성 예약: 2 / 1
- 최종 DB Seat / Redis: `HELD` / `HELD`
- pending/processing/retry/DLQ/in-flight: 모두 0
- artifact checksum: PASS

Migration 이후 `local-consistency-one-seat-20261002100203-81317`도 다시 실행해 4개 동시 요청에서 accepted 1, conflict 3, DB 활성 예약 1과 ID 감사 PASS를 확인했다.

### 정적·계약 검증

- Prisma schema validation과 client generation 통과
- migration SQL 수동 검토: 행 삭제·UPDATE·TRUNCATE 없음
- Nest build 통과
- k6 Node 단위 테스트 38개 통과
- 관련 Jest 단위 테스트 21개 통과
- 실제 Nest HTTP/인증/취소 권한·Swagger 계약 테스트 12개 통과
- rebooking 서버 통합 테스트 2개 통과
- `k6 inspect --execution-requirements`: `per-vu-iterations`, 1 VU × 1 iteration, accepted 2 통과 조건 확인
- `git diff --check` 통과

## 보안 검토 반영

취소·확정 API는 JWT 인증뿐 아니라 예약 소유권을 확인한다. 다른 사용자의 예약 ID에는 404를 반환해 존재 여부 노출을 줄이고, 잘못된 ID는 저장소 접근 전에 거부한다. ORM 조건 query만 사용하며 raw SQL에 사용자 입력을 연결하지 않는다. 오류 응답에는 내부 DB·Redis 정보나 stack을 포함하지 않고, k6 artifact에도 token·password·연결 문자열을 저장하지 않는다.

## 한계

DB transaction과 Redis 갱신은 단일 원자 transaction이 아니다. 현재 순서는 DB commit 후 Redis를 await하여 DB 롤백 뒤 캐시만 풀리는 위험을 피하고, Redis 실패는 503으로 드러낸다. 이 경우 cache TTL 또는 명시적 복구가 필요할 수 있으며, queue·장애 복구 의미론은 7단계에서 별도 검증한다.
