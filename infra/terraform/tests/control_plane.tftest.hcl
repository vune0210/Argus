mock_provider "aws" {}

run "verify_control_plane_invariants" {
  command = plan

  variables {
    environment                   = "staging"
    aws_region                    = "ap-southeast-1"
    enable_control_plane_services = false
    enable_execution_infra        = true
    api_image_digest              = ""
    web_image_digest              = ""
    worker_image_digest           = ""
    worker_secret_arns = {
      DATABASE_URL          = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:argus/db"
      REDIS_URL             = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:argus/redis"
      PROBE_TOKEN_HMAC_KEY  = "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:argus/hmac"
    }
  }

  # 1. Health check paths
  assert {
    condition     = aws_lb_target_group.api.health_check[0].path == "/health/ready"
    error_message = "API target group health check path must be /health/ready"
  }

  assert {
    condition     = aws_lb_target_group.web.health_check[0].path == "/api/health"
    error_message = "Web target group health check path must be /api/health"
  }

  # 2. Encryption
  assert {
    condition     = aws_db_instance.postgres.storage_encrypted == true
    error_message = "RDS storage must be encrypted"
  }

  assert {
    condition     = aws_elasticache_replication_group.execution[0].at_rest_encryption_enabled == true && aws_elasticache_replication_group.execution[0].transit_encryption_enabled == true
    error_message = "ElastiCache must have both at-rest and transit encryption enabled"
  }

  # 3. Private networking
  assert {
    condition     = length(aws_subnet.app_private) == 2 && length(aws_subnet.data_private) == 2
    error_message = "VPC must have 2 app private and 2 data private subnets"
  }

  assert {
    condition     = aws_ecs_service.api.network_configuration[0].assign_public_ip == false
    error_message = "API ECS tasks must not be assigned public IPs"
  }

  assert {
    condition     = aws_ecs_service.web.network_configuration[0].assign_public_ip == false
    error_message = "Web ECS tasks must not be assigned public IPs"
  }

  # 4. Desired count gate: 0 when digests are empty
  assert {
    condition     = aws_ecs_service.api.desired_count == 0 && aws_ecs_service.web.desired_count == 0 && aws_ecs_service.worker[0].desired_count == 0
    error_message = "Desired count must be gated to 0 when services disabled or digests empty"
  }

  # 5. Immutable digest configuration
  assert {
    condition     = aws_ecr_repository.service["api"].image_tag_mutability == "IMMUTABLE" && aws_ecr_repository.service["web"].image_tag_mutability == "IMMUTABLE" && aws_ecr_repository.service["probe"].image_tag_mutability == "IMMUTABLE"
    error_message = "ECR image tag mutability must be IMMUTABLE"
  }
}
