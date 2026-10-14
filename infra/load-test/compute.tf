resource "aws_ecr_repository" "app" {
  name                 = "${local.name}/app"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep ten immutable images for baseline and candidate replay"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_ecr_repository" "runner" {
  name                 = "${local.name}/runner"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "runner" {
  repository = aws_ecr_repository.runner.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the five most recent runner images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 5
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_instance" "app" {
  count = local.image_uri == null ? 0 : var.app_instance_count

  ami                         = data.aws_ami.al2023.id
  instance_type               = var.app_instance_type
  subnet_id                   = [aws_subnet.public.id, aws_subnet.public_secondary.id][count.index % 2]
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = true
  monitoring                  = false

  credit_specification {
    cpu_credits = "standard"
  }

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted             = true
    volume_size           = 15
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/templates/app-user-data.sh.tftpl", {
    aws_region     = var.aws_region
    image_uri      = local.image_uri == null ? "IMAGE_NOT_CONFIGURED" : local.image_uri
    ecr_registry   = split("/", aws_ecr_repository.app.repository_url)[0]
    parameter_name = aws_ssm_parameter.app.name
    database_host  = aws_db_instance.postgres.address
    database_port  = aws_db_instance.postgres.port
    database_name  = local.database_name
    redis_host     = aws_elasticache_replication_group.redis.primary_endpoint_address
    redis_port     = aws_elasticache_replication_group.redis.port
    environment_id = var.environment_id
    redis_prefix   = local.redis_prefix
    app_build_sha  = var.app_build_sha
    pm2_instances  = var.pm2_app_instances
    run_migration  = count.index == 0
  })

  tags = {
    Name                    = "${local.name}-app-${format("%02d", count.index + 1)}"
    Role                    = "application-and-load-target"
    FastPassImageDigest     = var.app_image_digest
    FastPassBuildSha        = var.app_build_sha
    FastPassPm2Workers      = tostring(var.pm2_app_instances)
    FastPassDbPoolPerWorker = "4"
  }


  lifecycle {
    # Application releases are performed by the SSM deployment document.
    # A digest change must not replace the seven load-test hosts.
    # Release identity tags are updated only after SSM verifies the rollout;
    # Terraform must not claim a new release before the containers change.
    ignore_changes = [
      ami,
      user_data,
      tags["FastPassImageDigest"],
      tags["FastPassBuildSha"],
    ]
  }
}

resource "aws_instance" "load_generator" {
  count = var.enable_load_generator ? 1 : 0

  ami           = data.aws_ami.al2023.id
  instance_type = var.load_generator_instance_type
  # c7i-flex.large is offered in ap-northeast-2b/2d, not in the primary 2a subnet.
  subnet_id                            = aws_subnet.public_secondary.id
  vpc_security_group_ids               = [aws_security_group.load_generator.id]
  iam_instance_profile                 = aws_iam_instance_profile.load_generator.name
  associate_public_ip_address          = true
  monitoring                           = true
  user_data_replace_on_change          = true
  instance_initiated_shutdown_behavior = "terminate"

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
    # The digest-pinned runner uses the instance role from inside its container.
    # This host has no inbound security-group rules.
    http_put_response_hop_limit = 2
  }

  root_block_device {
    encrypted             = true
    volume_size           = 30
    volume_type           = "gp3"
    delete_on_termination = true
  }

  user_data = templatefile("${path.module}/templates/load-generator-user-data.sh.tftpl", {
    aws_region                        = var.aws_region
    runner_image_uri                  = local.runner_image_uri == null ? "IMAGE_NOT_CONFIGURED" : local.runner_image_uri
    ecr_registry                      = split("/", aws_ecr_repository.runner.repository_url)[0]
    load_generator_max_lifetime_hours = var.load_generator_max_lifetime_hours
  })

  tags = {
    Name                   = "${local.name}-load-generator"
    Role                   = "ephemeral-k6-generator"
    FastPassRunnerDigest   = var.runner_image_digest
    FastPassRunnerBuildSha = local.runner_build_sha
  }

  lifecycle {
    precondition {
      condition     = local.runner_image_uri != null
      error_message = "runner_image_digest is required when enable_load_generator=true."
    }
  }
}
