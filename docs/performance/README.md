# FastPass 성능 검증 문서

- [변경 계획](./CHANGE_PLAN.md): 포트폴리오와 k6 테스트를 어떤 기준으로 변경할지 설명한다.
- [단계별 실행 프롬프트](./EXECUTION_PROMPTS.md): 사실 감사부터 실제 테스트와 포트폴리오 반영까지 순서대로 실행할 프롬프트를 제공한다.
- [요약 노트](./SUMMARY_NOTE.md): 변경 기준, 실행 단계와 핵심 중단 조건을 빠르게 확인한다.
- [2단계 검증 기록](./PHASE2_VERIFICATION.md): k6 공통 기반의 정적 검증과 격리 Smoke 실행 근거를 기록한다.
- [3단계 검증 기록](./PHASE3_VERIFICATION.md): Run별 artifact 봉인, queue drain과 ID 정합성 감사의 격리 통합 근거를 기록한다.
- [4단계 검증 기록](./PHASE4_VERIFICATION.md): 예약 API의 구조화된 성공·오류 계약과 k6 분류기 검증 근거를 기록한다.
- [5단계 검증 기록](./PHASE5_VERIFICATION.md): 단일 좌석·균등 inventory의 결정적 요청 배정과 Warm/Cold Cache 격리 통합 검증 근거를 기록한다.
- [6단계 검증 기록](./PHASE6_VERIFICATION.md): 취소·만료 이력을 보존하면서 활성 예약 단일성과 동일 좌석 재예약을 검증한 근거를 기록한다.
- [7단계 큐 내구성 검증](./QUEUE_DURABILITY.md): DB 실패와 worker 중단 경계의 메시지 보존·복구 가능성, `NO_GO` 판정과 설계 대안을 기록한다.

## 권장 진행 순서

1. `CHANGE_PLAN.md`에서 목표, 통과 조건, 결과 보존 원칙을 확인한다.
2. `EXECUTION_PROMPTS.md`의 0단계에서 레거시 원격 실행 경로를 먼저 격리한 뒤 순서대로 진행한다.
3. 정적 검사, 격리 통합 검증, 승인 원격 검증을 구분하고 각 단계가 요구하는 완료 Gate를 충족한 뒤 다음 의존 단계로 넘어간다.
4. 원격 부하 테스트는 12단계에서 만료되지 않은 승인 manifest와 자동 중단 장치를 검증한 경우에만 격리 비운영 환경에서 실행한다. 운영 환경에는 실행하지 않는다.
5. 큐 내구성 단계가 `NO_GO`이면 처리량 qualification, Spike·Soak와 포트폴리오 성과 반영을 진행하지 않는다.
6. 실제 결과가 생성되기 전에는 README나 포트폴리오의 성능 수치를 확정값으로 변경하지 않는다.
