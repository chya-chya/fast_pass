# 8단계 부하 테스트 관측성 검증

## 판정

**`INTEGRATION_VERIFIED` — 격리된 실제 request → enqueue → process → DB persistence 흐름과 Run별 관측 artifact 검증 완료**

원격 모니터링 환경에는 배포하지 않았고 원격 부하도 실행하지 않았다. 최종 검증은 loopback 임시 포트, tmpfs PostgreSQL·Redis, 실행 종료 시 삭제되는 전용 Compose 환경에서 수행했다.

## 구현 결과

### 예약과 Redis Streams

- API 요청 총수와 `accepted` / `expected_conflict` / `unexpected_failure`를 분리했다.
- 좌석 Lua 결과를 `OK` / `FAIL` / `MISS` / `WAIT` / `ERROR` / `UNKNOWN`으로 제한했다.
- 기존 `reservation_queue_total{status}`의 성공뿐 아니라 enqueue 실패도 실제로 증가하도록 수정했다.
- 처리 성공·실패, stream depth, PEL processing, delivery count 2 이상 retry, DLQ와 최고령 메시지 나이를 노출한다.
- PEL scan 상한으로 retry 수가 불완전할 때 `reservation_queue_retry_scan_complete=0`으로 판정을 막는다.
- Redis `XADD` 시각부터 DB commit 또는 idempotent reconciliation까지를 `reservation_persistence_latency_seconds` Histogram으로 기록한다.
- scheduler batch 크기와 실행 시간을 Histogram으로 기록한다.

### Node·PM2와 label

모든 앱 metric에는 `host`, `app_instance`, `pm_id`, `pid`, `worker_generation`만 공통 label로 사용한다. `userId`, `seatId`, `reservationId`, `runId`는 Prometheus label에 포함하지 않는다.

Node 기본 metric으로 event-loop lag, RSS, heap 사용량과 process start time을 수집한다. PM2 CPU·메모리·uptime·restart·loop delay의 query와 집계 규칙은 [METHODOLOGY.md](./METHODOLOGY.md)에 기록했다. 로컬 일회성 Run은 PM2를 사용하지 않으므로 `server-metrics.json`에 명시적인 `unavailable` 사유를 남겼다.

### Scrape와 tracing 분리

- 테스트 Prometheus profile은 1~5초를 허용하고 기본 2초다.
- production profile은 기본 15초이며 15초 미만 설정을 entrypoint가 거부한다.
- tracing은 parent-based trace-id ratio sampler를 사용하며 기본 sample ratio는 0.1이다.
- `OTEL_MIN_SPAN_DURATION_MS`로 span duration filter를 제어하고, 이전의 1초 미만 고정 폐기를 제거했다.
- health preflight가 tracing on/off, sample ratio와 duration filter를 기대 profile과 대조한다.

### Run별 관측 artifact

Runner는 부하 직전과 drain·감사 직후 `/metrics` allowlist snapshot을 수집한다. Counter와 Histogram은 두 snapshot의 차이로 계산하고, queue와 process Gauge는 종료 snapshot으로 기록한다.

`server-metrics.json` schema v2에는 다음을 저장한다.

- UTC Run 시간창
- 앱 metric 원본 query 이름과 누락 목록
- 요청·Lua·enqueue·processed counter delta
- queue·PEL·retry·DLQ·최고령 메시지 최종값
- 영속화 지연과 scheduler Histogram 요약
- RSS·heap·event-loop lag·process start time
- PostgreSQL·Redis 종료 snapshot과 아직 없는 시계열 목록
- PM2 미사용 또는 수집 불가 사유

필수 앱 metric 누락, counter reset, Redis 수집 실패 또는 불완전한 PEL scan은 observability audit 실패로 처리한다.

## 최종 격리 Smoke

- Run ID: `local-smoke-20261008032627-49293`
- 소스: `6c48a9e850d6db2053e8441652e459bfde9b1a26`
- source 상태: `gitDirty=false`
- 실행: `COMPLETED`
- artifact set: `FINALIZED`
- preflight: `VERIFIED`
- consistency audit: `PASS`
- observability audit: `PASS`
- 앱 metric 상태: `available`, `valid=true`, 누락 0건
- checksum: 6개 artifact 모두 통과

실제 흐름은 다음 delta로 확인했다.

```text
request total       = 1
accepted            = 1
Lua OK              = 1
enqueue success     = 1
processed success   = 1
persistence samples = 1
```

종료 시 queue 상태는 `depth / processing / retry / DLQ = 0 / 0 / 0 / 0`이고, `collectionUp=1`, `retryScanComplete=1`이다. persistence Histogram의 1개 sample은 기능 연결 확인용이며 처리량 또는 제품 성능 수치로 사용하지 않는다.

증거: [`k6/results/local-smoke-20261008032627-49293/`](../../k6/results/local-smoke-20261008032627-49293/)

## 중간 진단 기록

- `local-smoke-20261008032334-46625`: Linux 전용 `process_heap_bytes`가 macOS에서 누락되어 `app.valid=false`로 거부됐다. 플랫폼 공통 `nodejs_heap_size_used_bytes`로 변경했다.
- `local-smoke-20261008032443-47827`: 수정 뒤 관측성 감사가 통과했지만 구현 검증 중인 dirty source였으므로 최종 근거로 사용하지 않는다.

## 검증 결과

- `npm run build`: 통과
- 관련 Jest: **63개 통과**, 조건부 통합 10개 제외
- k6 Node 테스트: **40/40 통과**
- `k6 inspect --execution-requirements k6/scenarios/smoke.js`: 통과
- `docker compose config --quiet`: 통과
- `docker compose -f docker-compose.monitoring.yaml config --quiet`: 통과
- `docker compose -f docker-compose.prod.yaml config --quiet`: 통과
- 변경된 관측성 TypeScript 대상 ESLint: 통과
- shell 문법 검사와 `git diff --check`: 통과
- `/metrics` sample: 필수 metric 누락 0건, 고카디널리티 business ID label 없음

## 남은 경계

- 로컬 검증은 PM2 cluster를 사용하지 않았다. 원격 qualification 전에 모든 PM2 worker를 고정 identity로 수집하는 경로를 preflight로 증명해야 한다.
- PostgreSQL query latency·lock wait와 Redis command latency는 종료 snapshot만 있으며 세부 시계열은 아직 없다. 원격 실행에서는 승인된 Prometheus query 범위와 원본 시계열 URI·checksum이 필요하다.
- `reservation_queue_retry_messages`는 설정한 PEL scan 상한 안에서만 정확하다. 상한을 넘으면 `retry_scan_complete=0`으로 fail-closed 처리한다.
