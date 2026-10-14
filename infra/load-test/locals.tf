locals {
  name = var.project_name
  azs  = slice(data.aws_availability_zones.available.names, 0, 2)

  common_tags = {
    Project       = "fast_pass"
    Environment   = "load-test"
    EnvironmentId = var.environment_id
    ManagedBy     = "terraform"
    Disposable    = "true"
    Production    = "false"
    CostProfile   = "paid-load-test"
  }

  database_name    = "fast_pass_k6_${replace(var.environment_id, "-", "_")}"
  redis_prefix     = "k6:${var.environment_id}:"
  image_uri        = var.app_image_digest == null ? null : "${aws_ecr_repository.app.repository_url}@${var.app_image_digest}"
  runner_image_uri = var.runner_image_digest == null ? null : "${aws_ecr_repository.runner.repository_url}@${var.runner_image_digest}"
  runner_build_sha = coalesce(var.runner_build_sha, var.app_build_sha)
}
