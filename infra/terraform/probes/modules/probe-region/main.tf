terraform {
  required_providers { aws = { source = "hashicorp/aws", version = ">= 5.0, < 7.0" } }
}
variable "environment" { type = string }
variable "control_plane_url" { type = string }
variable "vpc_cidr" { type = string }
variable "token_secret_arn" { type = string }
variable "kms_key_arn" {
  type    = string
  default = null
}
variable "desired_count" { type = number }
variable "image_digest" {
  type = string
  validation {
    condition     = (var.image_digest == "" && var.desired_count == 0) || can(regex("^sha256:[a-f0-9]{64}$", var.image_digest))
    error_message = "A pinned sha256 digest is required before starting tasks."
  }
}
data "aws_region" "current" {}
data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }
locals {
  name     = "argus-${var.environment}-probe"
  region   = data.aws_region.current.name
  probe_id = "managed-${local.region}"
}
resource "aws_vpc" "probe" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name, Environment = var.environment }
}
resource "aws_internet_gateway" "probe" { vpc_id = aws_vpc.probe.id }
resource "aws_subnet" "probe" {
  count                   = 2
  vpc_id                  = aws_vpc.probe.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false
}
resource "aws_route_table" "probe" {
  vpc_id = aws_vpc.probe.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.probe.id
  }
}
resource "aws_route_table_association" "probe" {
  count          = 2
  subnet_id      = aws_subnet.probe[count.index].id
  route_table_id = aws_route_table.probe.id
}
resource "aws_security_group" "probe" {
  name        = local.name
  description = "No inbound connections; TCP egress (1-65535) for HTTP, TCP, SSL, keyword checks and control plane access"
  vpc_id      = aws_vpc.probe.id
  egress {
    protocol    = "tcp"
    from_port   = 1
    to_port     = 65535
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_ecr_repository" "probe" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration { scan_on_push = true }
}
resource "aws_cloudwatch_log_group" "probe" {
  name              = "/argus/${var.environment}/probe/${local.region}"
  retention_in_days = 30
}
resource "aws_ecs_cluster" "probe" { name = local.name }
resource "aws_iam_role" "execution" {
  # IAM is account-global, so region must be part of the role name.
  name               = "${local.name}-${local.region}"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "execution" {
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
      { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = aws_ecr_repository.probe.arn },
      { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.probe.arn}:*" },
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = var.token_secret_arn }
      ], var.kms_key_arn == null ? [] : [{
        Effect    = "Allow", Action = ["kms:Decrypt"], Resource = var.kms_key_arn,
        Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${local.region}.amazonaws.com" } }
    }])
  })
  lifecycle {
    precondition {
      condition     = startswith(var.token_secret_arn, "arn:aws:secretsmanager:${local.region}:${data.aws_caller_identity.current.account_id}:secret:")
      error_message = "Token secret must belong to this account and probe region."
    }
    precondition {
      condition     = var.kms_key_arn == null ? true : startswith(var.kms_key_arn, "arn:aws:kms:${local.region}:${data.aws_caller_identity.current.account_id}:key/")
      error_message = "KMS key must belong to this account and probe region."
    }
  }
}
resource "aws_ecs_task_definition" "probe" {
  count                    = var.image_digest == "" ? 0 : 1
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution.arn
  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name    = "probe", image = "${aws_ecr_repository.probe.repository_url}@${var.image_digest}", essential = true,
    command = ["run"], user = "65532:65532", readonlyRootFilesystem = true, stopTimeout = 120,
    environment = [
      { name = "ARGUS_ENV", value = var.environment },
      { name = "ARGUS_CONTROL_PLANE_URL", value = var.control_plane_url },
      { name = "ARGUS_PROBE_ID", value = local.probe_id },
      { name = "ARGUS_REGION", value = local.region },
      { name = "ARGUS_CONCURRENCY", value = "4" },
      { name = "ARGUS_ALLOW_PRIVATE_TARGETS", value = "false" }
    ],
    secrets = [{ name = "ARGUS_TOKEN", valueFrom = var.token_secret_arn }],
    logConfiguration = { logDriver = "awslogs", options = {
      awslogs-group = aws_cloudwatch_log_group.probe.name, awslogs-region = local.region, awslogs-stream-prefix = "probe"
    } }
  }])
}
resource "aws_ecs_service" "probe" {
  count                              = var.image_digest == "" ? 0 : 1
  name                               = local.name
  cluster                            = aws_ecs_cluster.probe.id
  task_definition                    = aws_ecs_task_definition.probe[0].arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  enable_execute_command             = false
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.probe[*].id
    security_groups  = [aws_security_group.probe.id]
    assign_public_ip = true
  }
  depends_on = [aws_route_table_association.probe, aws_iam_role_policy.execution]
}
output "deployment" {
  value = { region = local.region, probe_id = local.probe_id, repository_url = aws_ecr_repository.probe.repository_url,
    cluster = aws_ecs_cluster.probe.name, service = try(aws_ecs_service.probe[0].name, null), image_digest = var.image_digest,
  log_group = aws_cloudwatch_log_group.probe.name }
}
