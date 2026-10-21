resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = local.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[0]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 0)
  map_public_ip_on_launch = true
  tags = {
    Name = "${local.name}-public"
    Tier = "public-app"
  }
}

resource "aws_subnet" "public_secondary" {
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[1]
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, 1)
  map_public_ip_on_launch = true
  tags = {
    Name = "${local.name}-public-2"
    Tier = "public-app"
  }
}

resource "aws_subnet" "data" {
  count = 2

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, 20 + count.index)
  tags = {
    Name = "${local.name}-data-${count.index + 1}"
    Tier = "private-data"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${local.name}-public" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table_association" "public_secondary" {
  subnet_id      = aws_subnet.public_secondary.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Internal FastPass ALB; HTTP only from the in-VPC load generator"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "HTTP from the ephemeral load generator"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.load_generator.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "app" {
  name = "${local.name}-app"
  # Preserve the existing description to avoid replacing the security group during this rollout.
  description = "FastPass app; no SSH, HTTP only from the configured tester"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "Application traffic and health checks from the ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  ingress {
    description     = "Per-worker Prometheus metrics from the load generator"
    from_port       = 9300
    to_port         = 9301
    protocol        = "tcp"
    security_groups = [aws_security_group.load_generator.id]
  }

  ingress {
    description     = "PM2 exporter metrics from the load generator"
    from_port       = 9209
    to_port         = 9209
    protocol        = "tcp"
    security_groups = [aws_security_group.load_generator.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "database" {
  name        = "${local.name}-postgres"
  description = "PostgreSQL from the FastPass app only"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }


  ingress {
    description     = "PostgreSQL audit access from the load generator"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.load_generator.id]
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.name}-redis"
  description = "TLS Redis from the FastPass app only"
  vpc_id      = aws_vpc.this.id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }


  ingress {
    description     = "TLS Redis audit access from the load generator"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.load_generator.id]
  }
}

resource "aws_security_group" "load_generator" {
  name        = "${local.name}-load-generator"
  description = "Ephemeral k6 generator with no inbound access"
  vpc_id      = aws_vpc.this.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
