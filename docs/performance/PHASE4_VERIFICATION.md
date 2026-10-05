# 4단계 검증 기록

## 판정

- 실행일: 2026-10-01
- 최종 상태: `INTEGRATION_VERIFIED`
- 검증 범위: 예약 API 결과 계약, Swagger schema, k6 공통 분류기
- 원격 요청·부하 테스트: 실행하지 않음

실제 Nest HTTP 요청 경로에서 JWT guard, ValidationPipe, controller, 전역 예외 필터와 응답 직렬화를 함께 검증했다. Redis·queue·DB 실패 매핑은 ReservationService 단위 테스트로 검증했다.

## 예약 결과 계약

| 결과                    |                           HTTP | code                               | k6 분류             |
| ----------------------- | -----------------------------: | ---------------------------------- | ------------------- |
| 예약 접수               |                            201 | `RESERVATION_ACCEPTED`             | `accepted`          |
| 이미 점유된 좌석        |                            409 | `SEAT_ALREADY_RESERVED`            | `expected_conflict` |
| 존재하지 않는 좌석      |                            404 | `SEAT_NOT_FOUND`                   | `unexpected_error`  |
| 인증 실패               |                            401 | `AUTHENTICATION_REQUIRED`          | `unexpected_error`  |
| 입력 오류               |                            400 | `INVALID_REQUEST`                  | `unexpected_error`  |
| Redis/Lua 실패          |                            503 | `RESERVATION_STORE_UNAVAILABLE`    | `unexpected_error`  |
| enqueue 실패            |                            503 | `RESERVATION_QUEUE_UNAVAILABLE`    | `unexpected_error`  |
| DB 실패                 |                            503 | `RESERVATION_DATABASE_UNAVAILABLE` | `unexpected_error`  |
| lock backend 실패       |                            503 | `RESERVATION_LOCK_UNAVAILABLE`     | `unexpected_error`  |
| 서버 처리 timeout       |                            504 | `REQUEST_TIMEOUT`                  | `timeout`           |
| 전송 timeout            | status 0과 명시적 timeout 신호 | body 없음                          | `timeout`           |
| 정의되지 않은 내부 오류 |                            500 | `INTERNAL_ERROR`                   | `unexpected_error`  |

성공 body는 `code`, 안전한 `message`, `requestId`, `id`, `userId`, `seatId`, `status`, `reservedAt`을 반환한다. 오류 body는 `statusCode`, `code`, 안전한 `message`, `requestId`만 반환한다. 같은 correlation 값은 `X-Request-Id` 응답 header에도 기록한다. 요청 header가 없거나 허용 형식이 아니면 서버가 UUID를 생성한다.

## 정상 충돌 경계

`409 + SEAT_ALREADY_RESERVED`만 정상적인 좌석 경합이다. Lua 명령 오류, pipeline 실패·불완전 결과, enqueue 실패, Redis 상태 갱신 실패, DB 조회 실패와 lock backend 실패는 409로 변환하지 않는다.

내부 예외 message, Redis key, SQL·연결 문자열, stack과 token은 응답에 복사하지 않는다. 정의되지 않은 예외는 고정된 `500 + INTERNAL_ERROR`로 축약한다.

## k6 분류 규칙

- `accepted`: `201 + RESERVATION_ACCEPTED + PENDING`이며 예약 ID, 안전한 request ID와 message가 모두 있어야 한다.
- `expected_conflict`: `409 + statusCode 409 + SEAT_ALREADY_RESERVED`이며 request ID와 message가 있어야 한다.
- `timeout`: `504 + statusCode 504 + REQUEST_TIMEOUT` 또는 status 0과 명시적인 전송 timeout 신호다.
- 나머지는 모두 `unexpected_error`다.

응답 누락, 빈 body, JSON 파싱 실패, 누락된 correlation, status/code 불일치, 일반 연결 실패는 fail-closed로 `unexpected_error`가 된다. 따라서 인프라 장애가 정상 충돌 counter에 포함되지 않는다.

## Swagger와 검증

다음 검사를 통과했다.

- Nest build
- k6 Node 단위 테스트 30개
- ReservationService 실패 매핑 테스트 5개
- 실제 Nest HTTP·인증·validation·예외·Swagger 계약 테스트 11개
- Swagger의 201, 400, 401, 404, 409, 500, 503, 504 응답과 DTO required field 확인
- k6 smoke 실행 요구사항 inspect
- `git diff --check`

실제 HTTP 계약 테스트에서 성공, 좌석 경합, 좌석 없음, 인증 실패, 입력 오류, Redis/Lua, enqueue, DB, lock, timeout과 내부 오류 조합을 모두 확인했다. 내부 연결 문자열을 포함한 예외를 주입해도 응답에는 고정된 안전 message만 반환됐다.

## 호환성 영향과 전환 방법

성공 응답은 기존 `id`, `userId`, `seatId`, `status`, `reservedAt`을 유지하고 `code`, `message`, `requestId`를 추가했다. 테스트 전용 `runId`는 공개 응답에서 제거했다.

다음 변경은 기존 client가 오류 body나 status를 엄격히 해석한다면 호환성 영향이 있다.

- Redis·queue·lock 오류가 409에서 503으로 변경된다.
- 모든 API 오류 body가 `statusCode`, `code`, `message`, `requestId` 구조로 표준화된다.
- 입력 DTO에 없는 추가 필드와 안전한 좌석 ID 형식을 벗어난 값은 400으로 거부된다.
- 내부 예외 message는 더 이상 client에 전달되지 않는다.

Client는 message 문자열 대신 `code`로 분기해야 한다. `SEAT_ALREADY_RESERVED`만 사용자에게 정상 경합으로 표시하고, 503은 재시도 가능한 시스템 장애 정책으로, 500은 일반 내부 오류로 처리한다. 요청 추적에는 응답 body 또는 `X-Request-Id`를 사용한다.

## 보안 검토 반영

좌석 ID와 request ID는 허용 문자와 길이로 제한했다. 오류 응답과 로그에는 내부 예외 객체를 직렬화하지 않고, URL query 대신 path와 안전한 correlation ID만 기록한다. 인증·입력 오류도 내부 guard/validator 세부 내용을 노출하지 않는 고정 message를 사용한다.
