data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "app" {
  name               = "${local.name}-app"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "app_ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "app_runtime" {
  statement {
    sid       = "ReadOnlyApplicationParameter"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.app.arn]
  }

  statement {
    sid = "PullOnlyApplicationImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.app.arn]
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "app_runtime" {
  name   = "runtime"
  role   = aws_iam_role.app.id
  policy = data.aws_iam_policy_document.app_runtime.json
}

resource "aws_iam_instance_profile" "app" {
  name = "${local.name}-app"
  role = aws_iam_role.app.name
}

resource "aws_iam_role" "load_generator" {
  name               = "${local.name}-load-generator"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "load_generator_ssm" {
  role       = aws_iam_role.load_generator.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

data "aws_iam_policy_document" "load_generator" {
  statement {
    sid       = "ReadRuntimeParameter"
    actions   = ["ssm:GetParameter"]
    resources = [aws_ssm_parameter.app.arn]
  }

  statement {
    sid = "PullRunnerImage"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.runner.arn]
  }

  dynamic "statement" {
    for_each = var.enable_runner_image_build ? [1] : []
    content {
      sid = "BuildRunnerImage"
      actions = [
        "ecr:CompleteLayerUpload",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart",
      ]
      resources = [aws_ecr_repository.runner.arn]
    }
  }

  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "ArtifactReadWrite"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.artifacts.arn}/*"]
  }

  # S3 returns 403 rather than 404 for a missing object unless the caller can
  # list that exact prefix. Resume uses HEAD only to distinguish an incomplete
  # run from a sealed one, so keep the permission limited to run artifacts.
  statement {
    sid       = "DetectMissingRunArtifacts"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.artifacts.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        "runs/summary/*",
        "runs/raw/*",
      ]
    }
  }

  statement {
    sid = "VerifyArtifactBucketControls"
    actions = [
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
      "s3:GetBucketPublicAccessBlock",
      "s3:GetBucketVersioning",
    ]
    resources = [aws_s3_bucket.artifacts.arn]
  }

  statement {
    sid = "RuntimeInventory"
    actions = [
      "ec2:DescribeInstances",
      "elasticloadbalancing:DescribeLoadBalancers",
      "elasticloadbalancing:DescribeTargetGroups",
      "elasticloadbalancing:DescribeTargetHealth",
      "rds:DescribeDBInstances",
      "elasticache:DescribeReplicationGroups",
      "elasticache:DescribeCacheClusters",
      "cloudwatch:GetMetricData",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "load_generator" {
  name   = "runtime"
  role   = aws_iam_role.load_generator.id
  policy = data.aws_iam_policy_document.load_generator.json
}

resource "aws_iam_instance_profile" "load_generator" {
  name = "${local.name}-load-generator"
  role = aws_iam_role.load_generator.name
}
