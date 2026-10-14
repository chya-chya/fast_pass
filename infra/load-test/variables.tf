variable "aws_region" {
  type    = string
  default = "ap-northeast-2"

  validation {
    condition     = var.aws_region == "ap-northeast-2"
    error_message = "This environment is pinned to Seoul (ap-northeast-2)."
  }
}

variable "project_name" {
  type    = string
  default = "fast-pass-free"
}

variable "environment_id" {
  description = "Unique disposable environment identity recorded in test artifacts."
  type        = string
  default     = "aws-free-01"

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$", var.environment_id))
    error_message = "environment_id must be 3-32 characters using letters, digits, underscore, or hyphen."
  }
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "app_instance_type" {
  type    = string
  default = "t3.small"

  validation {
    condition     = var.app_instance_type == "t3.small"
    error_message = "The load-test application fleet is pinned to t3.small."
  }
}

variable "app_instance_count" {
  description = "Number of identical EC2 application instances."
  type        = number
  default     = 7

  validation {
    condition     = var.app_instance_count == 7
    error_message = "The load-test application fleet is pinned to seven instances."
  }
}

variable "pm2_app_instances" {
  description = "PM2 cluster workers per EC2 application instance."
  type        = number
  default     = 2

  validation {
    condition     = var.pm2_app_instances == 2
    error_message = "Each application server is pinned to two PM2 workers."
  }
}

variable "load_generator_instance_type" {
  description = "Ephemeral k6 load generator instance type."
  type        = string
  default     = "c7i-flex.large"

  validation {
    condition     = var.load_generator_instance_type == "c7i-flex.large"
    error_message = "The formal load generator is pinned to the Seoul Free Tier eligible c7i-flex.large."
  }
}

variable "load_generator_max_lifetime_hours" {
  description = "Fail-safe lifetime for the ephemeral generator. The instance terminates itself even when cleanup is missed."
  type        = number
  default     = 26

  validation {
    condition = (
      var.load_generator_max_lifetime_hours >= 2 &&
      var.load_generator_max_lifetime_hours <= 26 &&
      floor(var.load_generator_max_lifetime_hours) == var.load_generator_max_lifetime_hours
    )
    error_message = "The load generator lifetime must be an integer from 2 through 26 hours."
  }
}

variable "enable_load_generator" {
  description = "Create the ephemeral in-VPC k6 generator. Disable it between approved runs."
  type        = bool
  default     = false
}

variable "runner_image_digest" {
  description = "Immutable digest for the k6 runner ECR image. Required when enable_load_generator is true."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.runner_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.runner_image_digest))
    error_message = "runner_image_digest must be null or a sha256 digest."
  }
}

variable "artifact_bucket_force_destroy" {
  description = "Keep false outside disposable development. Artifact retention is deliberate."
  type        = bool
  default     = false
}

variable "app_image_digest" {
  description = "Immutable ECR digest. When null, Terraform creates no EC2 app instance."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.app_image_digest == null || can(regex("^sha256:[0-9a-f]{64}$", var.app_image_digest))
    error_message = "app_image_digest must be null or a sha256 digest."
  }
}

variable "app_build_sha" {
  type    = string
  default = "4f78e46cf16ac488e847122a6e5bb3ea26351bf5"

  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.app_build_sha))
    error_message = "app_build_sha must be a full lowercase Git SHA."
  }
}

variable "runner_build_sha" {
  description = "Full Git SHA used to build the remote runner image. Defaults to app_build_sha when both images come from one source revision."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.runner_build_sha == null || can(regex("^[0-9a-f]{40}$", var.runner_build_sha))
    error_message = "runner_build_sha must be null or a full lowercase Git SHA."
  }
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"

  validation {
    condition     = contains(["db.t3.micro", "db.t4g.micro"], var.db_instance_class)
    error_message = "RDS must use a PostgreSQL Free Tier eligible class."
  }
}

variable "redis_node_type" {
  type    = string
  default = "cache.t3.micro"

  validation {
    condition     = var.redis_node_type == "cache.t3.micro"
    error_message = "Legacy ElastiCache Free Tier covers cache.t3.micro only."
  }
}

variable "monthly_budget_usd" {
  description = "Guardrail only: a budget does not cap or stop AWS spending."
  type        = number
  default     = 10
}

variable "budget_notification_email" {
  description = "Optional email for budget alerts."
  type        = string
  default     = null
  nullable    = true
}
