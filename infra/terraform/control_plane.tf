# Control Plane Infrastructure: VPC Subnets, NAT, RDS PostgreSQL 16, ALB Host-Based Routing, CloudFront, ECS Fargate

variable "domain_name" {
  description = "Base domain name for the environment (e.g., staging.argus.monitoring)"
  type        = string
  default     = "staging.argus.monitoring"
}

variable "route53_zone_id" {
  description = "Existing Route53 Hosted Zone ID for DNS record management"
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "Existing or verified ACM certificate ARN covering *.staging.<domain> and staging.<domain>"
  type        = string
  default     = ""
}

variable "enable_control_plane_services" {
  description = "Start ECS services (API, Web, Worker). Keep false during foundation plan/bootstrap."
  type        = bool
  default     = false
}

variable "api_desired_count" {
  type    = number
  default = 1
}

variable "web_desired_count" {
  type    = number
  default = 1
}

variable "api_image_digest" {
  description = "Immutable digest for the API container image (e.g. sha256:abc...)"
  type        = string
  default     = ""
}

variable "web_image_digest" {
  description = "Immutable digest for the Web container image"
  type        = string
  default     = ""
}

variable "worker_image_digest" {
  description = "Immutable digest for the Worker container image"
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# 1. VPC Subnets & NAT Gateway
# -----------------------------------------------------------------------------
resource "aws_subnet" "app_private" {
  count             = 2
  vpc_id            = aws_vpc.control_plane.id
  availability_zone = data.aws_availability_zones.available.names[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 2)
  tags              = { Name = "${local.name}-app-private-${count.index + 1}" }
}

resource "aws_subnet" "data_private" {
  count             = 2
  vpc_id            = aws_vpc.control_plane.id
  availability_zone = data.aws_availability_zones.available.names[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 4)
  tags              = { Name = "${local.name}-data-private-${count.index + 1}" }
}

resource "aws_eip" "nat" {
  domain = "vpc"
  tags   = { Name = "${local.name}-nat-eip" }
}

resource "aws_nat_gateway" "control_plane" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = "${local.name}-nat" }

  depends_on = [aws_internet_gateway.control_plane]
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.control_plane.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.control_plane.id
  }

  tags = { Name = "${local.name}-private" }
}

resource "aws_route_table_association" "app_private" {
  count          = length(aws_subnet.app_private)
  subnet_id      = aws_subnet.app_private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_route_table_association" "data_private" {
  count          = length(aws_subnet.data_private)
  subnet_id      = aws_subnet.data_private[count.index].id
  route_table_id = aws_route_table.private.id
}

# -----------------------------------------------------------------------------
# 2. RDS PostgreSQL 16 (Encrypted, 7-Day Backup / PITR)
# -----------------------------------------------------------------------------
resource "aws_db_subnet_group" "postgres" {
  name       = "${local.name}-postgres"
  subnet_ids = aws_subnet.data_private[*].id
  tags       = { Name = "${local.name}-postgres-subnet-group" }
}

resource "aws_security_group" "postgres" {
  name        = "${local.name}-postgres"
  description = "PostgreSQL access only from the control-plane app security group"
  vpc_id      = aws_vpc.control_plane.id

  ingress {
    protocol        = "tcp"
    from_port       = 5432
    to_port         = 5432
    security_groups = [aws_security_group.control_plane.id]
  }

  tags = { Name = "${local.name}-postgres" }
}

resource "aws_db_instance" "postgres" {
  identifier                  = "${local.name}-db"
  engine                      = "postgres"
  engine_version              = "16.2"
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  max_allocated_storage       = 100
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "argus"
  username                    = "argus_admin"
  manage_master_user_password = true
  backup_retention_period     = 7
  copy_tags_to_snapshot       = true
  deletion_protection         = false
  skip_final_snapshot         = true
  db_subnet_group_name        = aws_db_subnet_group.postgres.name
  vpc_security_group_ids      = [aws_security_group.postgres.id]

  tags = { Name = "${local.name}-db" }
}

# -----------------------------------------------------------------------------
# 3. Application Load Balancer & Host-Based Routing
# -----------------------------------------------------------------------------
resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "ALB ingress for API, Web, and Status page"
  vpc_id      = aws_vpc.control_plane.id

  ingress {
    protocol    = "tcp"
    from_port   = 80
    to_port     = 80
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    protocol    = "tcp"
    from_port   = 443
    to_port     = 443
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-alb" }
}

# Allow ALB traffic into app tasks on port 4000 (API) and 3000 (Web)
resource "aws_security_group_rule" "app_from_alb_api" {
  type                     = "ingress"
  security_group_id        = aws_security_group.control_plane.id
  source_security_group_id = aws_security_group.alb.id
  protocol                 = "tcp"
  from_port                = 4000
  to_port                  = 4000
}

resource "aws_security_group_rule" "app_from_alb_web" {
  type                     = "ingress"
  security_group_id        = aws_security_group.control_plane.id
  source_security_group_id = aws_security_group.alb.id
  protocol                 = "tcp"
  from_port                = 3000
  to_port                  = 3000
}

resource "aws_lb" "control_plane" {
  name               = "${local.name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  tags = { Name = "${local.name}-alb" }
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 4000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.control_plane.id
  target_type = "ip"

  health_check {
    path                = "/health/ready"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.name}-tg-api" }
}

resource "aws_lb_target_group" "web" {
  name        = "${local.name}-web"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.control_plane.id
  target_type = "ip"

  health_check {
    path                = "/api/health"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = { Name = "${local.name}-tg-web" }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.control_plane.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.acm_certificate_arn != "" ? 1 : 0
  load_balancer_arn = aws_lb.control_plane.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}

# Host-based routing rules:
# 1. api.staging.<domain> -> API Target Group
resource "aws_lb_listener_rule" "api_host" {
  count        = var.acm_certificate_arn != "" ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    host_header {
      values = ["api.${var.domain_name}"]
    }
  }
}

# 2. app.staging.<domain> -> Web Target Group (Note: Next.js handles /api/auth, /api/backend, /api/public)
resource "aws_lb_listener_rule" "app_host" {
  count        = var.acm_certificate_arn != "" ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 20

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    host_header {
      values = ["app.${var.domain_name}"]
    }
  }
}

# 3. status.staging.<domain> -> Web Target Group (served via CloudFront)
resource "aws_lb_listener_rule" "status_host" {
  count        = var.acm_certificate_arn != "" ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 30

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    host_header {
      values = ["status.${var.domain_name}"]
    }
  }
}

# -----------------------------------------------------------------------------
# 4. CloudFront Distribution for Status Page
# -----------------------------------------------------------------------------
resource "aws_cloudfront_distribution" "status_page" {
  comment             = "Argus Public Status Page Cache (${var.environment})"
  enabled             = true
  is_ipv6_enabled     = true
  price_class         = "PriceClass_100"
  aliases             = var.acm_certificate_arn != "" ? ["status.${var.domain_name}"] : []

  origin {
    domain_name = aws_lb.control_plane.dns_name
    origin_id   = "alb-status-page"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = var.acm_certificate_arn != "" ? "https-only" : "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }

    custom_header {
      name  = "X-Argus-Status-Host"
      value = "status.${var.domain_name}"
    }
  }

  default_cache_behavior {
    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD"]
    target_origin_id = "alb-status-page"

    forwarded_values {
      query_string = true
      headers      = ["Host", "X-Argus-Status-Host"]

      cookies {
        forward = "none"
      }
    }

    viewer_protocol_policy = "redirect-to-https"
    min_ttl                = 0
    default_ttl            = 15
    max_ttl                = 60
    compress               = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn            = var.acm_certificate_arn != "" ? var.acm_certificate_arn : null
    cloudfront_default_certificate = var.acm_certificate_arn == "" ? true : false
    ssl_support_method             = var.acm_certificate_arn != "" ? "sni-only" : null
    minimum_protocol_version       = var.acm_certificate_arn != "" ? "TLSv1.2_2021" : null
  }

  tags = { Name = "${local.name}-status-cdn" }
}

# -----------------------------------------------------------------------------
# 5. Route53 DNS Records
# -----------------------------------------------------------------------------
resource "aws_route53_record" "api" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "api.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.control_plane.dns_name
    zone_id                = aws_lb.control_plane.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "app" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "app.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_lb.control_plane.dns_name
    zone_id                = aws_lb.control_plane.zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "status" {
  count   = var.route53_zone_id != "" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "status.${var.domain_name}"
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.status_page.domain_name
    zone_id                = aws_cloudfront_distribution.status_page.hosted_zone_id
    evaluate_target_health = false
  }
}

# -----------------------------------------------------------------------------
# 6. ECS Cluster & Fargate Services (API, Web, Worker)
# -----------------------------------------------------------------------------
resource "aws_ecs_cluster" "control_plane" {
  name = "${local.name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${local.name}-cluster" }
}

# Minimal Task IAM Role for API and Worker
resource "aws_iam_role" "app_task_role" {
  name = "${local.name}-app-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

# API/Worker minimal notification & secret access
resource "aws_iam_role_policy" "app_minimal_permissions" {
  name = "${local.name}-minimal-permissions"
  role = aws_iam_role.app_task_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ses:SendEmail"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = "*"
      }
    ]
  })
}

# Task Execution Role (ECR pull, CloudWatch logs)
resource "aws_iam_role" "app_task_execution_role" {
  name = "${local.name}-task-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "app_task_execution_managed" {
  role       = aws_iam_role.app_task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# API Task Definition
resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.app_task_execution_role.arn
  task_role_arn            = aws_iam_role.app_task_role.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.api_image_digest != "" ? "${aws_ecr_repository.service["api"].repository_url}@${var.api_image_digest}" : "${aws_ecr_repository.service["api"].repository_url}:${var.execution_image_tag}"
    essential = true
    portMappings = [{ containerPort = 4000, hostPort = 4000, protocol = "tcp" }]
    readonlyRootFilesystem = true
    stopTimeout = 30
    environment = [
      { name = "NODE_ENV", value = var.environment },
      { name = "PORT", value = "4000" },
      { name = "AUTH_MODE", value = "cognito" },
      { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.argus.id },
      { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.web.id }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["api"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "api"
      }
    }
  }])
}

# Web Task Definition
resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.app_task_execution_role.arn

  container_definitions = jsonencode([{
    name      = "web"
    image     = var.web_image_digest != "" ? "${aws_ecr_repository.service["web"].repository_url}@${var.web_image_digest}" : "${aws_ecr_repository.service["web"].repository_url}:${var.execution_image_tag}"
    essential = true
    portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
    readonlyRootFilesystem = true
    stopTimeout = 30
    environment = [
      { name = "NODE_ENV", value = var.environment },
      { name = "PORT", value = "3000" },
      { name = "NEXTAUTH_URL", value = "https://app.${var.domain_name}" }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.service["web"].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "web"
      }
    }
  }])
}

# ECS Fargate Services
resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.control_plane.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.enable_control_plane_services ? var.api_desired_count : 0
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.app_private[*].id
    security_groups  = [aws_security_group.control_plane.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 4000
  }
}

resource "aws_ecs_service" "web" {
  name            = "${local.name}-web"
  cluster         = aws_ecs_cluster.control_plane.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = var.enable_control_plane_services ? var.web_desired_count : 0
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.app_private[*].id
    security_groups  = [aws_security_group.control_plane.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3000
  }
}

# Exactly one worker instance
resource "aws_ecs_service" "worker" {
  count           = var.enable_execution_infra ? 1 : 0
  name            = "${local.name}-worker"
  cluster         = aws_ecs_cluster.control_plane.id
  task_definition = aws_ecs_task_definition.execution["worker"].arn
  desired_count   = var.enable_control_plane_services ? 1 : 0
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.app_private[*].id
    security_groups  = [aws_security_group.control_plane.id]
    assign_public_ip = false
  }
}
