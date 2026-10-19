# FastPass AWS 원격 부하 테스트 환경

서울 리전(`ap-northeast-2`)에 폐기 가능한 비운영 부하 테스트 환경을 구성합니다. 애플리케이션은 `t3.small` 7대에서 각각 PM2 worker 2개로 실행되고, 테스트 시간에만 `c7i-flex.large` 발생기를 켭니다. ALB는 VPC 내부 전용이며 맥북은 승인·배포 명령만 전달합니다. 이 계정에서는 원래 계획의 `c7i.large`가 프리 티어 제한으로 거부되므로, 같은 2 vCPU·4 GiB 구성이고 서울 리전에서 계정이 허용하는 `c7i-flex.large`로 고정합니다.

이 구성은 프리 티어가 아닙니다. EC2 8대, ALB, 퍼블릭 IPv4, EBS, CloudWatch, ECR 및 데이터 전송 비용이 발생할 수 있습니다. RDS와 Redis가 마이크로 사양이므로 결과는 앱 단독 성능이 아니라 DB·캐시를 포함한 전체 시스템 한계로 해석해야 합니다.

## 구성

- 애플리케이션: `t3.small` 7대, PM2 worker 총 14개
- 부하 발생기: 실행 시에만 생성하는 `c7i-flex.large` 1대
- 발생기 가용 영역: 해당 유형을 제공하는 `ap-northeast-2b`
- 진입점: 발생기 보안 그룹에서만 80번 포트로 접근 가능한 internal ALB
- 앱 지표: 발생기에서만 접근 가능한 worker별 9300·9301번 포트
- PM2 지표: 발생기에서만 접근 가능한 인스턴스별 9209번 포트
- PostgreSQL: Single-AZ `db.t4g.micro`, 전용 비공개 DB
- Redis: TLS 전용 `cache.t3.micro` 1노드, 비공개 엔드포인트
- 산출물: 버전 관리·암호화·공개 차단이 적용된 S3 버킷
- 보존: 요약·감사·cleanup·체크섬은 영구, 압축 원본 시계열은 90일
- 관리: SSH 없이 SSM만 사용
- 배포: 이미지 digest를 고정하고 SSM으로 7대를 한 대씩 교체하며 migration은 대표 노드에서 한 번만 실행

발생기 보안 그룹에는 인바운드 규칙이 없습니다. 테스트 제어 토큰과 DB 비밀번호는 발생기 호스트의 tmpfs에서 컨테이너 환경으로만 전달되며 로그와 S3 산출물에 포함하지 않습니다.
발생기는 정상 cleanup을 놓쳐도 26시간 뒤 스스로 종료되며, 게스트 종료가 EC2 종료로 이어지도록 구성합니다. 이는 비용 안전장치일 뿐 정상 종료 명령을 대신하지 않습니다.

## Terraform 준비

`terraform.tfvars.example`을 Git에서 제외된 `terraform.tfvars`로 복사합니다. 처음에는 발생기를 끄고 ECR과 기반 인프라를 만든 다음, 앱과 러너 이미지를 ECR에 올려 실제 digest를 채웁니다. `app_image_digest`와 `runner_image_digest`는 태그가 아니라 ECR의 변경 불가능한 `sha256:` digest여야 합니다.

```sh
# 1차: ECR과 기반 인프라 생성
terraform -chdir=infra/load-test init
terraform -chdir=infra/load-test plan -out=load-test.tfplan
terraform -chdir=infra/load-test apply load-test.tfplan

# 러너는 EC2와 같은 Linux/AMD64 이미지로 빌드해 ECR에 push
docker build --platform linux/amd64 \
  -f k6/remote/Dockerfile \
  -t <RUNNER_ECR_URL>:<IMMUTABLE_TAG> .

# ECR에서 확인한 sha256 digest를 terraform.tfvars에 기록한 뒤 2차 적용
terraform -chdir=infra/load-test plan -out=load-test.tfplan
terraform -chdir=infra/load-test apply load-test.tfplan
```

적용 전 다음 항목을 반드시 확인합니다.

- AWS 계정과 서울 리전이 승인 대상과 같은지
- 애플리케이션 7대와 발생기 1대의 비용·서비스 할당량
- RDS·Redis가 기존 사양을 유지하며 교체되지 않는지
- ALB가 `internal`이고 공개 CIDR 인바운드가 없는지
- S3 버전 관리와 `runs/raw/` 90일 수명 주기가 유지되는지

## 승인 파일

발생기 ID도 승인 대상이므로 순서는 반드시 `발생기 생성 → 승인서 작성·승인 → 버전 고정 업로드 → 검증·실행 → 발생기 종료`입니다. runner는 승인 파일을 생성하거나 수정하지 않습니다.

먼저 다른 인프라를 건드리지 않는지 계획을 확인한 뒤 임시 발생기를 켭니다. `start`는 저장된 Terraform 계획에서 `aws_instance.load_generator[0]` 생성 외의 변경이 하나라도 있으면 거부합니다.

```sh
k6/manage-remote-generator plan-start
k6/manage-remote-generator start --execute
```

발생기가 `READY`가 되면 승인 책임자와 실행 시간창을 명시해 candidate-only 승인 초안을 생성합니다. 아래 사유와 증거는 실제 승인 기록에 맞게 작성해야 하며 예시 문구를 그대로 승인 근거로 사용하면 안 됩니다. 이미 존재하는 파일은 덮어쓰지 않습니다.

```sh
k6/prepare-remote-approval \
  --approval-id <ID> \
  --approved-by <승인자> \
  --cost-owner <비용담당자> \
  --incident-owner <중단대응담당자> \
  --starts-at <UTC_ISO8601> \
  --ends-at <UTC_ISO8601> \
  --baseline-absence-reason '<기준선 부재 사유>' \
  --baseline-absence-evidence '<근거 문서 또는 기록>' \
  --output k6/remote/remote-approval.local.json \
  --acknowledge-candidate-only
```

승인자가 JSON의 환경·digest·부하 상한·중단 기준·cleanup 권한을 검토한 뒤에만 버전 고정 객체로 게시합니다. 게시 명령은 원문을 수정하지 않고 schema와 시간창을 검증하며, S3 Version ID와 SHA-256을 출력합니다.

```sh
k6/publish-remote-approval \
  --file k6/remote/remote-approval.local.json \
  --publish
```

실행에는 다음 네 값이 모두 필요합니다.

- approval ID
- S3의 null이 아닌 Version ID
- 해당 버전 원문에 대한 SHA-256
- `execute` 명령의 명시적 `--execute`

승인 버킷은 산출물 버킷과 같아야 하며, 승인 시간창은 최대 24시간입니다. 기준선이 없으면 `candidate-only`와 부재 사유·증거를 기록해야 하고 개선율을 계산하면 안 됩니다.

## 검증과 실행

먼저 실행하지 않는 검증으로 승인, Gate, 현재 AWS 실사값, 보존 정책과 전체 Run 행렬을 확인합니다.

```sh
REMOTE_APPROVAL_BUCKET=<버킷> k6/run-remote validate \
  --approval-id <ID> \
  --version-id <S3_VERSION_ID> \
  --checksum <SHA256>
```

검증 결과와 예상 비용을 승인한 뒤에만 실행합니다. `execute-remote-session`은 기존의 강제 `--execute` 검사를 그대로 사용하고 성공·실패·사용자 중단 뒤에 발생기 종료를 시도합니다.

```sh
REMOTE_APPROVAL_BUCKET=<버킷> k6/execute-remote-session \
  --approval-id <ID> \
  --version-id <S3_VERSION_ID> \
  --checksum <SHA256> \
  --execute
```

실행기는 승인 범위를 확대하지 않습니다. Smoke, 축소 정합성, VU/RPS 탐색, 50%·75% 확인, 100% 3회, 선택적 110%, Spike, Soak 순서로 진행합니다. 각 Run 뒤에는 drain, DB·Redis 감사, cleanup dry-run, exact cleanup, 잔존 확인, S3 업로드와 체크섬 봉인을 마쳐야 다음 Run으로 넘어갑니다.

중단된 실행을 이어갈 때는 기존 승인 객체를 덮어쓰지 않고 새 S3 버전을 만듭니다. 새 승인에는 `resume` 계보로 이전 Version ID·체크섬·실행 timestamp를 고정해야 합니다. 재개 러너는 이전 Run의 승인·이미지·감사·cleanup·체크섬을 모두 다시 검증한 뒤 봉인된 Run만 건너뜁니다. 미완료 Run의 흔적이 있으면 결정적 Run ID 범위만 exact cleanup하고 복구 기록을 S3에 영구 보존한 다음 그 Run부터 다시 실행합니다. 부하 상한, 중단 기준, 앱 이미지 또는 인프라 범위가 달라진 승인은 재개로 인정하지 않습니다.

```sh
k6/prepare-remote-approval \
  <기존 candidate-only 승인 인자> \
  --resume-source-file <검증한_이전_승인.json> \
  --resume-source-approval-id <이전_APPROVAL_ID> \
  --resume-source-version-id <이전_S3_VERSION_ID> \
  --resume-source-checksum <이전_SHA256> \
  --resume-execution-timestamp <이전_17자리_실행_TIMESTAMP>
```

자동 종료가 실패했다는 경고가 나오면 다음 명령으로 계획을 확인한 뒤 즉시 종료합니다. 이 명령도 발생기 삭제 외의 변경은 거부합니다.

```sh
k6/manage-remote-generator plan-stop
k6/manage-remote-generator stop --execute
```

## 중단 기준

14개 worker 지표, 7개 PM2 exporter, PostgreSQL, Redis, ALB Target Health, EC2 CPU credit와 발생기 CPU를 2초마다 감시합니다. 필수 입력을 시작 전에 읽지 못하면 k6를 실행하지 않습니다. RDS·Redis 자원 기준은 서로 다른 1분 CloudWatch datapoint 3개로 판정하며, qualification Run은 이를 수집할 최소 180초가 필요합니다. EC2 CPU credit은 5분 실제 datapoint 사이에서 `t3.small` 2 vCPU의 최대 소비량을 차감한 보수적 하한을 2초마다 계산합니다. 승인 파일에 고정된 오류율, DB 연결률, event-loop lag, queue 깊이, 발생기 CPU, CPU credit, eviction, restart, unhealthy target 기준을 3회 연속 위반하면 k6에 `SIGINT`를 보내고 Run을 `ABORTED`로 보존합니다. qualification 종료 시 RDS·Redis의 독립 표본이 부족해도 Run을 무효 처리합니다.

## 완료 판정

`REMOTE_VERIFIED`는 승인된 모든 Run이 실행 결과와 무관하게 가능한 산출물을 보존하고, 성공 Run이 정합성 감사·exact cleanup·watchdog·체크섬 검증을 모두 통과한 경우에만 기록됩니다. CPU credit 고갈, RDS·Redis 포화 또는 발생기 CPU 포화 Run은 앱 자체 한계의 근거로 사용하지 않습니다.

테스트가 끝나면 산출물의 S3 버전과 체크섬을 확인하고, 별도 Terraform 삭제 계획을 검토한 뒤 비용이 더 발생하지 않도록 환경을 철거합니다. AWS Budget은 알림 장치이며 지출을 자동 차단하지 않습니다.
