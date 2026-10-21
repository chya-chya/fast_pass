output "aws_account_id" {
  value = data.aws_caller_identity.current.account_id
}

output "region" {
  value = var.aws_region
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "runner_ecr_repository_url" {
  value = aws_ecr_repository.runner.repository_url
}

output "internal_base_url" {
  value = local.image_uri == null ? null : "http://${aws_lb.app[0].dns_name}"
}

output "internal_base_urls" {
  value = local.image_uri == null ? [] : ["http://${aws_lb.app[0].dns_name}"]
}

output "alb_dns_name" {
  value = local.image_uri == null ? null : aws_lb.app[0].dns_name
}

output "alb_arn" {
  value = local.image_uri == null ? null : aws_lb.app[0].arn
}

output "target_group_arn" {
  value = local.image_uri == null ? null : aws_lb_target_group.app[0].arn
}

output "instance_public_urls" {
  description = "Diagnostic addresses only; port 3000 accepts traffic from the ALB security group, not directly from the internet."
  value       = [for instance in aws_instance.app : "http://${instance.public_dns}:3000"]
}

output "app_instance_id" {
  value = local.image_uri == null ? null : aws_instance.app[0].id
}

output "app_instance_ids" {
  value = aws_instance.app[*].id
}

output "ssm_start_session_command" {
  value = local.image_uri == null ? null : "aws ssm start-session --region ${var.aws_region} --target ${aws_instance.app[0].id}"
}

output "ssm_start_session_commands" {
  value = [for instance in aws_instance.app : "aws ssm start-session --region ${var.aws_region} --target ${instance.id}"]
}

output "application_parameter_name" {
  value = aws_ssm_parameter.app.name
}

output "database_name" {
  value = local.database_name
}

output "database_identifier" {
  value = aws_db_instance.postgres.identifier
}

output "redis_replication_group_id" {
  value = aws_elasticache_replication_group.redis.id
}

output "deployment_readiness" {
  value = local.image_uri == null ? "INFRA_ONLY: push an image and set app_image_digest to create the application fleet" : "ALB_WITH_SEVEN_T3_SMALL_APPS_AND_TWO_PM2_WORKERS_EACH_REQUESTED"
}

output "load_generator_instance_id" {
  value = var.enable_load_generator ? aws_instance.load_generator[0].id : null
}

output "image_descriptor" {
  description = "Non-secret immutable image identities copied into an approval draft."
  value = {
    candidate = {
      git_sha = var.app_build_sha
      digest  = var.app_image_digest
    }
    runner = {
      git_sha = local.runner_build_sha
      digest  = var.runner_image_digest
    }
  }
}

output "artifact_bucket_name" {
  value = aws_s3_bucket.artifacts.id
}

output "deployment_document_name" {
  value = aws_ssm_document.deploy_app.name
}

output "remote_runner_document_name" {
  value = aws_ssm_document.run_approved_load_test.name
}

output "environment_descriptor" {
  value = {
    environment_id                    = var.environment_id
    aws_account_id                    = data.aws_caller_identity.current.account_id
    aws_region                        = var.aws_region
    alb_scheme                        = "internal"
    application_instance_type         = var.app_instance_type
    application_instance_count        = var.app_instance_count
    pm2_workers_per_instance          = var.pm2_app_instances
    total_pm2_workers                 = var.app_instance_count * var.pm2_app_instances
    database_instance_class           = var.db_instance_class
    redis_node_type                   = var.redis_node_type
    load_generator_instance_type      = var.load_generator_instance_type
    load_generator_max_lifetime_hours = var.load_generator_max_lifetime_hours
  }
}
