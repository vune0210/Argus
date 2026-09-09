variable "enable_execution_infra" {
  description = "Include week-two Redis and worker/probe task definitions in the plan. No services are started."
  type        = bool
  default     = false
}

variable "execution_image_tag" {
  type    = string
  default = "week2"
}

variable "control_plane_url" {
  type    = string
  default = "https://api.example.invalid"
  validation {
    condition     = startswith(var.control_plane_url, "https://")
    error_message = "Managed probes require an HTTPS control plane."
  }
}

variable "worker_secret_arns" {
  description = "Existing Secrets Manager ARNs keyed by DATABASE_URL, REDIS_URL and PROBE_TOKEN_HMAC_KEY. Never pass secret values."
  type        = map(string)
  default     = {}
}

variable "probe_secret_arns" {
  description = "Existing probe token secret ARNs keyed by simulated region."
  type        = map(string)
  default     = {}
}

variable "secret_kms_key_arns" {
  description = "Customer-managed KMS keys used by the referenced secrets, if any."
  type        = list(string)
  default     = []
}

locals {
  execution_tasks = var.enable_execution_infra ? merge({ worker = "worker" }, { for region, arn in var.probe_secret_arns : "probe-${region}" => region }) : {}
}

resource "aws_subnet" "execution_private" {
  count             = var.enable_execution_infra ? 2 : 0
  vpc_id            = aws_vpc.control_plane.id
  availability_zone = data.aws_availability_zones.available.names[count.index]
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  tags              = { Name = "${local.name}-execution-${count.index + 1}" }
}

resource "aws_security_group" "redis" {
  count       = var.enable_execution_infra ? 1 : 0
  name        = "${local.name}-redis"
  description = "Redis accessible only to the API and worker security group"
  vpc_id      = aws_vpc.control_plane.id
  ingress {
    protocol        = "tcp"
    from_port       = 6379
    to_port         = 6379
    security_groups = [aws_security_group.control_plane.id]
  }
}

resource "aws_vpc_security_group_egress_rule" "redis" {
  count                        = var.enable_execution_infra ? 1 : 0
  security_group_id            = aws_security_group.control_plane.id
  referenced_security_group_id = aws_security_group.redis[0].id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
}

resource "aws_elasticache_subnet_group" "execution" {
  count      = var.enable_execution_infra ? 1 : 0
  name       = "${local.name}-execution"
  subnet_ids = aws_subnet.execution_private[*].id
}

resource "aws_elasticache_replication_group" "execution" {
  count                      = var.enable_execution_infra ? 1 : 0
  replication_group_id       = "${local.name}-execution"
  description                = "Argus durable-outbox transport; PostgreSQL remains the source of truth"
  engine                     = "redis"
  engine_version             = "7.1"
  node_type                  = "cache.t4g.micro"
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name          = aws_elasticache_subnet_group.execution[0].name
  security_group_ids         = [aws_security_group.redis[0].id]
  snapshot_retention_limit   = 1
}

resource "aws_cloudwatch_log_group" "execution" {
  for_each          = local.execution_tasks
  name              = "/argus/${var.environment}/${each.key}"
  retention_in_days = 30
}

resource "aws_iam_role" "execution_task" {
  for_each = local.execution_tasks
  name     = "${local.name}-${each.key}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "execution_task" {
  for_each   = local.execution_tasks
  role       = aws_iam_role.execution_task[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = local.execution_tasks
  role     = aws_iam_role.execution_task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = each.key == "worker" ? values(var.worker_secret_arns) : [var.probe_secret_arns[each.value]]
    }], length(var.secret_kms_key_arns) == 0 ? [] : [{
      Effect   = "Allow"
      Action   = ["kms:Decrypt"]
      Resource = var.secret_kms_key_arns
    }])
  })
}

resource "aws_ecs_task_definition" "execution" {
  for_each                 = local.execution_tasks
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution_task[each.key].arn
  container_definitions = jsonencode([{
    name      = each.key
    image     = "${aws_ecr_repository.service[each.key == "worker" ? "api" : "probe"].repository_url}:${var.execution_image_tag}"
    essential = true
    command   = each.key == "worker" ? ["node", "apps/api/dist/worker.js"] : ["run"]
    readonlyRootFilesystem = true
    stopTimeout = 120
    environment = each.key == "worker" ? [
      { name = "NODE_ENV", value = var.environment },
      { name = "AUTH_MODE", value = "cognito" },
      { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.argus.id },
      { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.web.id },
      { name = "SCHEDULER_ENABLED", value = "false" }
    ] : [
      { name = "ARGUS_ENV", value = var.environment },
      { name = "ARGUS_CONTROL_PLANE_URL", value = var.control_plane_url },
      { name = "ARGUS_PROBE_ID", value = "managed-${each.value}" },
      { name = "ARGUS_REGION", value = each.value }
    ]
    secrets = each.key == "worker" ? [for name, arn in var.worker_secret_arns : { name = name, valueFrom = arn }] : [
      { name = "ARGUS_TOKEN", valueFrom = var.probe_secret_arns[each.value] }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.execution[each.key].name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "execution"
      }
    }
  }])
  lifecycle {
    precondition {
      condition     = alltrue([for key in ["DATABASE_URL", "REDIS_URL", "PROBE_TOKEN_HMAC_KEY"] : contains(keys(var.worker_secret_arns), key)])
      error_message = "Provide existing secret ARNs for all worker credentials before enabling execution infrastructure."
    }
  }
}

output "redis_primary_endpoint" {
  value = try(aws_elasticache_replication_group.execution[0].primary_endpoint_address, null)
}

output "execution_task_arns" {
  value = { for key, task in aws_ecs_task_definition.execution : key => task.arn }
}
