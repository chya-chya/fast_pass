resource "aws_ssm_document" "run_approved_load_test" {
  name            = "${local.name}-run-approved-load-test"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "Run a checksum-bound approved load test inside the VPC"
    parameters = {
      ApprovalBucket = {
        type              = "String"
        allowedPattern    = "^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$"
        interpolationType = "ENV_VAR"
      }
      ApprovalId = {
        type              = "String"
        allowedPattern    = "^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$"
        interpolationType = "ENV_VAR"
      }
      ApprovalVersionId = {
        type              = "String"
        allowedPattern    = "^[A-Za-z0-9._+=/-]+$"
        interpolationType = "ENV_VAR"
      }
      ApprovalChecksum = {
        type              = "String"
        allowedPattern    = "^[0-9a-f]{64}$"
        interpolationType = "ENV_VAR"
      }
      ExecutionTimestamp = {
        type              = "String"
        allowedPattern    = "^[0-9]{17}$"
        interpolationType = "ENV_VAR"
      }
      ImageRole = {
        type              = "String"
        allowedValues     = ["baseline", "candidate"]
        interpolationType = "ENV_VAR"
      }
      Execute = {
        type              = "String"
        allowedValues     = ["true"]
        interpolationType = "ENV_VAR"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "runApprovedLoadTest"
      inputs = {
        timeoutSeconds = "86400"
        runCommand = [
          "set -euo pipefail",
          "[ \"$SSM_Execute\" = 'true' ]",
          "runtime_file=/run/fast-pass/remote-runtime.env",
          "approval_file=/run/fast-pass/remote-approval.json",
          "trap 'rm -f \"$runtime_file\" \"$approval_file\"' EXIT",
          "aws s3api get-object --region '${var.aws_region}' --bucket \"$SSM_ApprovalBucket\" --key \"approvals/$SSM_ApprovalId.json\" --version-id \"$SSM_ApprovalVersionId\" \"$approval_file\" >/dev/null",
          "printf '%s  %s\\n' \"$SSM_ApprovalChecksum\" \"$approval_file\" | sha256sum -c -",
          "runner_image=$(cat /etc/fast-pass-runner-image)",
          "approved_runner_digest=$(jq -r '.images.runner.digest' \"$approval_file\")",
          "case \"$runner_image\" in *@\"$approved_runner_digest\") ;; *) echo 'runner digest mismatch' >&2; exit 1 ;; esac",
          "parameter_name=$(jq -r '.environment.applicationParameterName' \"$approval_file\")",
          "database_id=$(jq -r '.environment.databaseIdentifier' \"$approval_file\")",
          "redis_id=$(jq -r '.environment.redisReplicationGroupId' \"$approval_file\")",
          "database_name=$(jq -r '.environment.databaseName' \"$approval_file\")",
          "secret_json=$(aws ssm get-parameter --region '${var.aws_region}' --name \"$parameter_name\" --with-decryption --query Parameter.Value --output text)",
          "database_user=$(jq -r '.database_username' <<<\"$secret_json\")",
          "database_password=$(jq -r '.database_password | @uri' <<<\"$secret_json\")",
          "preflight_token=$(jq -r '.test_preflight_token' <<<\"$secret_json\")",
          "fixture_password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \\n')",
          "database_host=$(aws rds describe-db-instances --region '${var.aws_region}' --db-instance-identifier \"$database_id\" --query 'DBInstances[0].Endpoint.Address' --output text)",
          "database_port=$(aws rds describe-db-instances --region '${var.aws_region}' --db-instance-identifier \"$database_id\" --query 'DBInstances[0].Endpoint.Port' --output text)",
          "{ printf 'REMOTE_APPROVAL_BUCKET=%s\\n' \"$SSM_ApprovalBucket\"; printf 'REMOTE_APPROVAL_ID=%s\\n' \"$SSM_ApprovalId\"; printf 'REMOTE_APPROVAL_VERSION_ID=%s\\n' \"$SSM_ApprovalVersionId\"; printf 'REMOTE_APPROVAL_CHECKSUM=%s\\n' \"$SSM_ApprovalChecksum\"; printf 'REMOTE_EXECUTION_TIMESTAMP=%s\\n' \"$SSM_ExecutionTimestamp\"; printf 'REMOTE_IMAGE_ROLE=%s\\n' \"$SSM_ImageRole\"; printf 'RUNNER_IMAGE_DIGEST=%s\\n' \"$approved_runner_digest\"; printf 'TEST_PREFLIGHT_TOKEN=%s\\n' \"$preflight_token\"; printf 'FIXTURE_USER_PASSWORD=%s\\n' \"$fixture_password\"; printf 'AUDIT_DATABASE_URL=postgresql://%s:%s@%s:%s/%s?sslmode=require\\n' \"$database_user\" \"$database_password\" \"$database_host\" \"$database_port\" \"$database_name\"; printf 'AWS_REGION=${var.aws_region}\\n'; printf 'NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global-bundle.pem\\n'; printf 'PGSSLROOTCERT=/etc/ssl/certs/aws-rds-global-bundle.pem\\n'; } >\"$runtime_file\"",
          "chmod 0600 \"$runtime_file\"",
          "unset secret_json database_user database_password preflight_token fixture_password",
          "docker run --rm --network host --read-only --cap-drop ALL --security-opt no-new-privileges --env-file \"$runtime_file\" --tmpfs /app/k6/results:rw,noexec,nosuid,size=1g,uid=10001,gid=10001,mode=0700 --tmpfs /tmp:rw,noexec,nosuid,size=64m,uid=10001,gid=10001,mode=0700 \"$runner_image\" --execute"
        ]
      }
    }]
  })
}
