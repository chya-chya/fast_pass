ephemeral "random_password" "database" {
  length  = 32
  special = false
}

ephemeral "random_password" "jwt" {
  length  = 64
  special = false
}

ephemeral "random_password" "jwt_refresh" {
  length  = 64
  special = false
}

ephemeral "random_password" "preflight" {
  length  = 64
  special = false
}

resource "aws_ssm_parameter" "app" {
  name             = "/${local.name}/${var.environment_id}/app"
  description      = "Disposable FastPass Free Tier credentials"
  type             = "SecureString"
  tier             = "Standard"
  value_wo_version = 1
  value_wo = jsonencode({
    database_username    = "fastpass"
    database_password    = ephemeral.random_password.database.result
    jwt_secret           = ephemeral.random_password.jwt.result
    jwt_refresh_secret   = ephemeral.random_password.jwt_refresh.result
    test_preflight_token = ephemeral.random_password.preflight.result
  })
}
