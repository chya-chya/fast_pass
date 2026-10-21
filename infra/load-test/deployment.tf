resource "aws_ssm_document" "deploy_app" {
  name            = "${local.name}-deploy-app-digest"
  document_type   = "Command"
  document_format = "YAML"

  content = yamlencode({
    schemaVersion = "2.2"
    description   = "Deploy an immutable FastPass digest without replacing EC2 hosts"
    parameters = {
      ImageDigest = {
        type           = "String"
        allowedPattern = "^sha256:[0-9a-f]{64}$"
      }
      BuildSha = {
        type           = "String"
        allowedPattern = "^[0-9a-f]{40}$"
      }
      RunMigration = {
        type          = "String"
        allowedValues = ["true", "false"]
        default       = "false"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "deploy"
      inputs = {
        timeoutSeconds = "900"
        runCommand = [
          "set -euo pipefail",
          "image='${aws_ecr_repository.app.repository_url}@{{ ImageDigest }}'",
          "aws ecr get-login-password --region '${var.aws_region}' | docker login --username AWS --password-stdin '${split("/", aws_ecr_repository.app.repository_url)[0]}'",
          "docker pull \"$image\"",
          "curl --fail --silent --show-error --location https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem --output /etc/fast-pass/aws-rds-global-bundle.pem.next",
          "test \"$(wc -c </etc/fast-pass/aws-rds-global-bundle.pem.next)\" -gt 1000",
          "install -m 0444 /etc/fast-pass/aws-rds-global-bundle.pem.next /etc/fast-pass/aws-rds-global-bundle.pem",
          "rm -f /etc/fast-pass/aws-rds-global-bundle.pem.next",
          "if [ -d /etc/fast-pass/ecosystem.infrastructure.config.cjs ]; then rmdir /etc/fast-pass/ecosystem.infrastructure.config.cjs; fi",
          "printf '%s\\n' \"module.exports = { apps: [{ name: 'fast_pass', script: 'dist/src/main.js', instances: ${var.pm2_app_instances}, exec_mode: 'cluster', autorestart: true, watch: false, max_memory_restart: '500M' }, { name: 'pm2-metrics-exporter', script: 'dist/src/observability/pm2-metrics-exporter.js', instances: 1, exec_mode: 'fork', autorestart: true, env: { METRICS_PORT: 9209 } }] };\" > /etc/fast-pass/ecosystem.infrastructure.config.cjs",
          "chmod 0600 /etc/fast-pass/ecosystem.infrastructure.config.cjs",
          "# Keep RESERVATION_QUEUE_METRICS_COLLECTOR because it is assigned per EC2 instance by user-data.",
          "if ! grep -q '^RESERVATION_QUEUE_METRICS_COLLECTOR=' /etc/fast-pass/app.env; then if grep -q '^INSTANCE_ID=${try(aws_instance.app[0].id, "not-configured")}$' /etc/fast-pass/app.env; then printf '%s\\n' 'RESERVATION_QUEUE_METRICS_COLLECTOR=true' >> /etc/fast-pass/app.env; else printf '%s\\n' 'RESERVATION_QUEUE_METRICS_COLLECTOR=false' >> /etc/fast-pass/app.env; fi; fi",
          "sed -i -e '/^NODE_ENV=/d' -e '/^PRODUCTION=/d' -e '/^DB_POOL_SIZE=/d' -e '/^DB_SSL_MODE=/d' -e '/^DB_SSL_REJECT_UNAUTHORIZED=/d' -e '/^NODE_EXTRA_CA_CERTS=/d' -e '/^REDIS_USE_TLS=/d' -e '/^REDIS_TLS_VERIFY_HOSTNAME=/d' -e '/^TEST_ENVIRONMENT=/d' -e '/^TEST_ENV_ID=/d' -e '/^TEST_DATABASE_NAME=/d' -e '/^TEST_REDIS_ID=/d' -e '/^REDIS_KEY_PREFIX=/d' -e '/^ENABLE_TEST_PREFLIGHT=/d' -e '/^ALLOW_TEST_DATA_MUTATION=/d' -e '/^K6_ACCESS_TOKEN_TTL_SECONDS=/d' -e '/^ENABLE_TRACING=/d' -e '/^RESERVATION_METRICS_REFRESH_MS=/d' -e '/^PM2_APP_INSTANCES=/d' -e '/^WORKER_METRICS_ENABLED=/d' -e '/^WORKER_METRICS_BASE_PORT=/d' /etc/fast-pass/app.env",
          "printf '%s\\n' 'NODE_ENV=load-test' 'PRODUCTION=false' 'DB_POOL_SIZE=4' 'DB_SSL_MODE=require' 'DB_SSL_REJECT_UNAUTHORIZED=true' 'NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global-bundle.pem' 'REDIS_USE_TLS=true' 'REDIS_TLS_VERIFY_HOSTNAME=true' 'TEST_ENVIRONMENT=remote-disposable' 'TEST_ENV_ID=${var.environment_id}' 'TEST_DATABASE_NAME=${local.database_name}' 'TEST_REDIS_ID=${var.environment_id}' 'REDIS_KEY_PREFIX=${local.redis_prefix}' 'ENABLE_TEST_PREFLIGHT=true' 'ALLOW_TEST_DATA_MUTATION=true' 'K6_ACCESS_TOKEN_TTL_SECONDS=7200' 'ENABLE_TRACING=false' 'RESERVATION_METRICS_REFRESH_MS=5000' 'PM2_APP_INSTANCES=${var.pm2_app_instances}' 'WORKER_METRICS_ENABLED=true' 'WORKER_METRICS_BASE_PORT=9300' >> /etc/fast-pass/app.env",
          "sed -i 's/^APP_BUILD_SHA=.*/APP_BUILD_SHA={{ BuildSha }}/' /etc/fast-pass/app.env",
          "if [ '{{ RunMigration }}' = 'true' ]; then docker run --rm --env-file /etc/fast-pass/app.env -v /etc/fast-pass/aws-rds-global-bundle.pem:/etc/ssl/certs/aws-rds-global-bundle.pem:ro \"$image\" npx prisma migrate deploy; fi",
          "if [ '{{ RunMigration }}' = 'true' ]; then docker run --rm --env-file /etc/fast-pass/app.env \"$image\" node -e \"const Redis=require('ioredis');const r=new Redis({host:process.env.REDIS_HOST,port:Number(process.env.REDIS_PORT),tls:{servername:process.env.REDIS_HOST}});r.set(process.env.REDIS_KEY_PREFIX+'environment',JSON.stringify({testEnvId:process.env.TEST_ENV_ID,redisId:process.env.TEST_REDIS_ID,keyPrefix:process.env.REDIS_KEY_PREFIX})).then(()=>r.quit()).catch((error)=>{console.error(error.message);process.exit(1)})\"; fi",
          "docker rm -f fast-pass >/dev/null 2>&1 || true",
          "docker run -d --name fast-pass --restart unless-stopped --memory 1536m --env-file /etc/fast-pass/app.env -v /etc/fast-pass/ecosystem.infrastructure.config.cjs:/app/ecosystem.infrastructure.config.cjs:ro -v /etc/fast-pass/aws-rds-global-bundle.pem:/etc/ssl/certs/aws-rds-global-bundle.pem:ro -p 3000:3000 -p 9300-9301:9300-9301 -p 9209:9209 \"$image\" pm2-runtime start ecosystem.infrastructure.config.cjs",
          "for attempt in $(seq 1 60); do curl -fsS http://127.0.0.1:3000/ >/dev/null && break; sleep 1; done",
          "curl -fsS http://127.0.0.1:3000/ >/dev/null",
          "docker inspect fast-pass | jq -r '.[0].Config.Image'"
        ]
      }
    }]
  })
}
