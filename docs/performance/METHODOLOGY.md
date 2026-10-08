# FastPass 성능 관측 방법론

## 목적과 판정 경계

부하 실행 중 HTTP 접수, Redis Streams 적체, worker 처리와 PostgreSQL 영속화를 같은 시간창에서 관찰한다. 지표 누락이나 counter reset을 0으로 간주하지 않는다. 필수 지표가 누락되거나 worker 전체를 수집하지 못한 실행은 처리량 판정에 사용할 수 없다.

이 문서의 PromQL은 예시 dashboard 정의이며 실제 처리량 수치를 주장하지 않는다. 원격 모니터링 배포와 원격 부하는 8단계 범위가 아니다.

## VU Capacity 탐색 계약

`capacity-vu`는 폐쇄형 `ramping-vus` 탐색이며 목표 RPS를 설정하지 않는다. 기본 target은 `100 → 500 → 1,000 → 2,000 VU`, 각 target의 기본 hold는 3분이고 target 사이 ramp는 30초다. 단계별 요청 수를 해당 ramp+hold 측정창으로 나눈 실제 RPS를 결과에 남긴다. 마지막 단계는 종료 ramp까지 포함한다. 이 값은 target RPS나 지속 가능한 처리량이 아니다.

환경변수 계약은 다음과 같다.

| 설정                        | 기본값                  | 의미                                                    |
| --------------------------- | ----------------------- | ------------------------------------------------------- |
| `CAPACITY_VU_STAGES`        | `100,500,1000,2000`     | 정확히 네 개의 증가하는 VU target                       |
| `CAPACITY_RAMP_DURATION`    | `30s`                   | 각 target과 종료 0 VU까지의 ramp 시간                   |
| `CAPACITY_STAGE_HOLD_1`~`4` | 각각 `3m`               | target별 유지 시간                                      |
| `CAPACITY_PROFILE`          | `unique-seat`           | `unique-seat` 또는 `hot-seat`; 반드시 별도 Run으로 실행 |
| `CAPACITY_USER_BEHAVIOR`    | `reserve-then-think`    | `reserve-then-think` 또는 `think-then-reserve`          |
| `CAPACITY_THINK_TIME`       | `60s`                   | iteration 사이 사용자 대기 시간                         |
| `CAPACITY_REQUEST_BUDGET`   | `20,000` 이상 자동 계산 | 실행 전에 확보해야 하는 최대 요청·고유 좌석 예산        |

`unique-seat`는 전역 `iterationInTest`를 request ID와 좌석 index로 사용해 모든 요청을 서로 다른 좌석에 보낸다. `hot-seat`는 같은 전역 iteration ID로 사용자와 request ID를 구분하되 한 좌석에만 보낸다. 로컬 `__VU`는 배정 키로 사용하지 않는다. 사용자·token, 공연과 좌석은 setup에서 미리 만들고 load 측정 구간에서 제외한다. 보수적 예산 계산보다 fixture가 작으면 실행 전에 거부하며, 실행 중 예산을 넘으면 테스트를 중단한다.

성공, 예상 충돌, 예상하지 않은 오류와 timeout은 별도 Trend/Counter로 기록한다. p95/p99 threshold도 outcome별 metric에만 적용하며 전체 `http_req_duration`을 정상 예약 latency로 해석하지 않는다. Hot-seat의 최초 accepted 1건과 이후 expected conflict도 별도 metric으로 남는다.

판정 종류는 `exploratory`, 상태는 `NOT_APPLICABLE`이다. threshold 초과는 SLO 관측값으로 보존하지만 회귀 PASS/FAIL 또는 고정 RPS 달성 실패로 바꾸지 않는다. 실행 유효성은 전역 요청 manifest, accepted/processed/persisted ID, unexpected error, 앱 지표 완전성, 자원 포화와 queue/drain을 함께 확인한다. 원격 승인 환경에서 단계별 시계열을 수집하기 전에는 capacity 한계나 지속 가능한 처리량을 주장하지 않는다.

## 지표 계약

| 지표                                           | 종류      | label             | 의미                                                                                            |
| ---------------------------------------------- | --------- | ----------------- | ----------------------------------------------------------------------------------------------- |
| `reservation_request_total`                    | Counter   | worker 기본 label | 예약 API에 들어온 요청 수                                                                       |
| `reservation_request_outcome_total`            | Counter   | `outcome`         | `accepted`, `expected_conflict`, `unexpected_failure`                                           |
| `reservation_lua_result_total`                 | Counter   | `result`          | 좌석 상태 Lua 결과 `OK`, `FAIL`, `MISS`, `WAIT`, `ERROR`, `UNKNOWN`                             |
| `reservation_queue_total`                      | Counter   | `status`          | Redis Stream enqueue 성공·실패                                                                  |
| `reservation_processed_total`                  | Counter   | `status`          | scheduler 처리 성공·실패                                                                        |
| `reservation_queue_depth_messages`             | Gauge     | worker 기본 label | 아직 `XDEL`되지 않은 stream entry 수. 여러 worker에서 같은 Redis 값을 읽으므로 합산하지 않는다. |
| `reservation_queue_processing_messages`        | Gauge     | worker 기본 label | consumer group PEL 수                                                                           |
| `reservation_queue_retry_messages`             | Gauge     | worker 기본 label | delivery count가 2 이상인 PEL 수                                                                |
| `reservation_queue_dlq_messages`               | Gauge     | worker 기본 label | DLQ stream entry 수                                                                             |
| `reservation_queue_oldest_message_age_seconds` | Gauge     | worker 기본 label | 가장 오래된 미종결 stream entry의 나이                                                          |
| `reservation_queue_metrics_collection_up`      | Gauge     | worker 기본 label | 마지막 Redis 지표 수집 성공 여부                                                                |
| `reservation_queue_retry_scan_complete`        | Gauge     | worker 기본 label | retry gauge가 전체 PEL을 스캔했는지 여부                                                        |
| `reservation_persistence_latency_seconds`      | Histogram | worker 기본 label | Redis `XADD` 시각부터 DB commit 또는 idempotent reconciliation까지                              |
| `reservation_scheduler_batch_size`             | Histogram | worker 기본 label | scheduler 1회 실행의 성공 처리 건수                                                             |
| `reservation_scheduler_batch_duration_seconds` | Histogram | worker 기본 label | scheduler batch 실행 시간                                                                       |

모든 앱 지표에는 `host`, `app_instance`, `pm_id`, `pid`, `worker_generation`이 붙는다. 사용자·좌석·예약·Run ID는 label로 사용하지 않는다. `reservation_queue_retry_scan_complete=0`이면 retry 값은 하한일 뿐이므로 qualification을 중단한다.

Node 기본 지표에서 `nodejs_eventloop_lag_seconds`, `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `process_start_time_seconds`를 사용한다. PM2 exporter에서는 `pm2_cpu`, `pm2_memory`, `pm2_uptime`, `pm2_restarts`, `pm2_loop_delay`를 관찰한다.

## PM2 집계 규칙

- Counter는 worker별 `rate`/`increase`에서 reset을 보정한 다음 합산한다.
- queue gauge는 모든 worker가 같은 Redis 상태를 읽으므로 `max`를 사용하며 합산하지 않는다.
- RSS와 heap은 전체 합계와 worker 최댓값을 함께 본다.
- Event-loop lag와 오류율은 전체 집계와 worker 최악값을 함께 본다.
- Histogram bucket은 `le`별로 합산한 뒤 전체 분위수를 다시 계산한다. worker별 p95를 평균내지 않는다.
- `pid` 또는 `worker_generation` 변경, `process_start_time_seconds` 변화, `pm2_uptime` 감소는 재시작으로 판정한다.
- PM2 cluster의 공용 포트가 scrape마다 임의 worker를 반환하는 구성은 전체 집계가 아니다. 모든 worker의 고정 endpoint 또는 worker-aware collector가 확인되지 않으면 원격 qualification을 `INVALID`로 처리한다.

## PromQL과 Grafana 패널

아래 query의 시간 범위는 Run 시작·종료 시각과 정확히 일치시킨다.

| 패널                      | PromQL                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 예약 요청률               | `sum(rate(reservation_request_total[1m]))`                                                                                                                            |
| API 결과별 요청률         | `sum by (outcome) (rate(reservation_request_outcome_total[1m]))`                                                                                                      |
| Lua 결과별 비율           | `sum by (result) (rate(reservation_lua_result_total[1m]))`                                                                                                            |
| enqueue 성공·실패         | `sum by (status) (rate(reservation_queue_total[1m]))`                                                                                                                 |
| 처리 성공·실패            | `sum by (status) (rate(reservation_processed_total[1m]))`                                                                                                             |
| queue / PEL / retry / DLQ | `max(reservation_queue_depth_messages)`, `max(reservation_queue_processing_messages)`, `max(reservation_queue_retry_messages)`, `max(reservation_queue_dlq_messages)` |
| 최고령 메시지             | `max(reservation_queue_oldest_message_age_seconds)`                                                                                                                   |
| 영속화 지연 p95           | `histogram_quantile(0.95, sum by (le) (rate(reservation_persistence_latency_seconds_bucket[5m])))`                                                                    |
| 영속화 지연 p99           | `histogram_quantile(0.99, sum by (le) (rate(reservation_persistence_latency_seconds_bucket[5m])))`                                                                    |
| scheduler 처리량          | `sum(rate(reservation_scheduler_batch_size_sum[1m]))`                                                                                                                 |
| scheduler batch p95       | `histogram_quantile(0.95, sum by (le) (rate(reservation_scheduler_batch_duration_seconds_bucket[5m])))`                                                               |
| Event-loop lag 최악값     | `max(nodejs_eventloop_lag_seconds)`                                                                                                                                   |
| RSS 합계 / 최댓값         | `sum(process_resident_memory_bytes)`, `max(process_resident_memory_bytes)`                                                                                            |
| Heap 합계 / 최댓값        | `sum(nodejs_heap_size_used_bytes)`, `max(nodejs_heap_size_used_bytes)`                                                                                                |
| PM2 CPU·메모리            | `sum(pm2_cpu)`, `sum(pm2_memory)`                                                                                                                                     |
| PM2 재시작                | `sum(changes(pm2_uptime[5m]))`과 `sum(increase(pm2_restarts[5m]))`를 함께 확인                                                                                        |
| 수집 완전성               | `min(reservation_queue_metrics_collection_up)`, `min(reservation_queue_retry_scan_complete)`                                                                          |

Grafana dashboard는 API, queue, persistence, scheduler, Node/PM2, DB, Redis의 여섯 행으로 나눈다. 공통 annotation에는 Run ID, Git SHA, cache profile, tracing 조건과 부하 시작·종료 시각을 기록하되 Run ID를 Prometheus metric label로 추가하지 않는다.

## Scrape와 tracing profile

- 테스트 profile: `MONITORING_PROFILE=test`, `PROMETHEUS_SCRAPE_INTERVAL=1s`~`5s`; 기본 `2s`.
- 운영 profile: `MONITORING_PROFILE=production`; 기본 `15s`, 15초 미만은 entrypoint가 거부한다.
- tracing 기본값: `ENABLE_TRACING=false`, `OTEL_TRACE_SAMPLE_RATIO=0.1`, `OTEL_MIN_SPAN_DURATION_MS=0`.
- tracing을 켜면 parent-based trace-id ratio sampler를 적용한다. duration filter와 sample ratio는 별개이며, 이전처럼 1초 미만 span을 고정 폐기하지 않는다.
- 비교 Run은 tracing on/off, sample ratio, 최소 span duration을 metadata에 기록하고 서로 다른 profile을 직접 비교하지 않는다.

## Run별 `server-metrics.json`

Runner는 부하 시작 직전과 drain·감사 직후 `/metrics` allowlist snapshot을 수집한다. Counter와 Histogram은 두 snapshot의 차이로, queue와 process Gauge는 종료 snapshot으로 요약한다. `server-metrics.json`에는 UTC 시간창, 원본 query/metric 이름, 누락 지표, counter reset 여부를 함께 기록한다.

PostgreSQL과 Redis는 현재 격리 통합 환경에서 종료 snapshot만 저장한다. DB query latency·lock wait와 Redis command latency의 원본 시계열은 `missingMetrics`로 명시한다. PM2를 사용하지 않는 로컬 일회성 실행도 `unavailable` 사유를 기록한다. 이후 원격 qualification에서는 승인된 Prometheus 원본 query 범위와 외부 시계열 URI·checksum을 추가해야 한다.

다음 조건을 모두 만족해야 앱 관측 window를 유효하다고 본다.

1. 시작·종료 snapshot에 필수 metric family가 모두 있다.
2. counter reset이 없다.
3. `reservation_queue_metrics_collection_up=1`이다.
4. `reservation_queue_retry_scan_complete=1`이다.
5. PM2 사용 시 모든 worker의 고정 identity가 수집된다.
