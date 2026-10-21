resource "aws_lb" "app" {
  count = local.image_uri == null ? 0 : 1

  name                       = substr("${local.name}-app", 0, 32)
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = [aws_subnet.public.id, aws_subnet.public_secondary.id]
  enable_deletion_protection = false
  drop_invalid_header_fields = true
  idle_timeout               = 60

  tags = {
    Name = "${local.name}-alb"
    Role = "load-test-entrypoint"
  }
}

resource "aws_lb_target_group" "app" {
  count = local.image_uri == null ? 0 : 1

  name                 = substr("${local.name}-app", 0, 32)
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "instance"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/"
    protocol            = "HTTP"
    port                = "traffic-port"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name = "${local.name}-app"
  }
}

resource "aws_lb_target_group_attachment" "app" {
  count = local.image_uri == null ? 0 : var.app_instance_count

  target_group_arn = aws_lb_target_group.app[0].arn
  target_id        = aws_instance.app[count.index].id
  port             = 3000
}

resource "aws_lb_listener" "http" {
  count = local.image_uri == null ? 0 : 1

  load_balancer_arn = aws_lb.app[0].arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app[0].arn
  }
}
