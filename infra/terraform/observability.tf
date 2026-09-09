# CloudWatch Dashboard and Metric Alarms for Argus Observability

resource "aws_cloudwatch_dashboard" "argus" {
  dashboard_name = "${local.name}-operations"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", "${local.name}-alb", { stat = "Sum", period = 60, color = "#d62728" }],
            [".", "HTTPCode_Target_2XX_Count", ".", ".", { stat = "Sum", period = 60, color = "#2ca02c" }],
            [".", "RequestCount", ".", ".", { stat = "Sum", period = 60, color = "#1f77b4" }]
          ]
          view    = "timeSeries"
          stacked = false
          title   = "ALB Request Rates & 5XX Errors"
          region  = var.aws_region
          period  = 60
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", "${local.name}-cluster", "ServiceName", "${local.name}-api", { stat = "Average", period = 60 }],
            ["...", "ServiceName", "${local.name}-web", { stat = "Average", period = 60 }],
            ["...", "ServiceName", "${local.name}-worker", { stat = "Average", period = 60 }]
          ]
          view    = "timeSeries"
          stacked = false
          title   = "ECS Services CPU Utilization"
          region  = var.aws_region
          period  = 60
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", "${local.name}-db", { stat = "Average", period = 60 }],
            [".", "DatabaseConnections", ".", ".", { stat = "Average", period = 60, yAxis = "right" }]
          ]
          view    = "timeSeries"
          stacked = false
          title   = "RDS CPU & Database Connections"
          region  = var.aws_region
          period  = 60
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["AWS/ElastiCache", "CPUUtilization", "ReplicationGroupId", "${local.name}-execution", { stat = "Average", period = 60 }],
            [".", "CurrConnections", ".", ".", { stat = "Average", period = 60, yAxis = "right" }]
          ]
          view    = "timeSeries"
          stacked = false
          title   = "ElastiCache Redis CPU & Active Connections"
          region  = var.aws_region
          period  = 60
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["Argus/Worker", "QueueDepth", "Environment", var.environment, { stat = "Maximum", period = 60, color = "#ff7f0e" }],
            [".", "OutboxDepth", ".", ".", { stat = "Maximum", period = 60, color = "#9467bd" }],
            [".", "SchedulerLagSeconds", ".", ".", { stat = "Maximum", period = 60, yAxis = "right", color = "#d62728" }]
          ]
          view    = "timeSeries"
          stacked = false
          title   = "Worker Pipeline Queue Depth, Outbox & Scheduler Lag"
          region  = var.aws_region
          period  = 60
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["Argus/Worker", "NotificationFailures", "Environment", var.environment, { stat = "Sum", period = 60, color = "#d62728" }],
            [".", "NotificationRetries", ".", ".", { stat = "Sum", period = 60, color = "#ff7f0e" }],
            [".", "StaleProbesCount", ".", ".", { stat = "Maximum", period = 60, color = "#8c564b" }]
          ]
          view    = "timeSeries"
          stacked = false
          title   = "Notifications Health & Regional Probe Status"
          region  = var.aws_region
          period  = 60
        }
      }
    ]
  })
}

# 1. ALB 5xx Alarm
resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-alb-high-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "ALB target 5XX error count exceeds 10 per minute for 2 consecutive periods"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.control_plane.arn_suffix
  }
}

# 2. ECS Task Restart / Unhealthy Alarm
resource "aws_cloudwatch_metric_alarm" "ecs_task_restart" {
  alarm_name          = "${local.name}-ecs-task-restart"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 90
  alarm_description   = "ECS memory utilization exceeds 90%, risking OOM restart"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.control_plane.name
  }
}

# 3. RDS Health Alarm
resource "aws_cloudwatch_metric_alarm" "rds_health" {
  alarm_name          = "${local.name}-rds-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 80
  alarm_description   = "RDS PostgreSQL CPU utilization exceeds 80% for 3 consecutive minutes"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = aws_db_instance.postgres.identifier
  }
}

# 4. Redis Health Alarm
resource "aws_cloudwatch_metric_alarm" "redis_health" {
  alarm_name          = "${local.name}-redis-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ElastiCache"
  period              = 60
  statistic           = "Average"
  threshold           = 75
  alarm_description   = "ElastiCache Redis CPU utilization exceeds 75% for 3 consecutive minutes"
  treat_missing_data  = "notBreaching"

  dimensions = {
    ReplicationGroupId = "${local.name}-execution"
  }
}

# 5. Worker Queue Depth Alarm
resource "aws_cloudwatch_metric_alarm" "queue_depth" {
  alarm_name          = "${local.name}-worker-queue-depth"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "QueueDepth"
  namespace           = "Argus/Worker"
  period              = 60
  statistic           = "Maximum"
  threshold           = 50
  alarm_description   = "Worker queue depth exceeds 50 targets for 2 consecutive minutes"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Environment = var.environment
  }
}

# 6. Notification Delivery Failures Alarm
resource "aws_cloudwatch_metric_alarm" "notification_failures" {
  alarm_name          = "${local.name}-notification-failures"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "NotificationFailures"
  namespace           = "Argus/Worker"
  period              = 60
  statistic           = "Sum"
  threshold           = 5
  alarm_description   = "Notification delivery failures exceed 5 within 1 minute"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Environment = var.environment
  }
}

# 7. Stale Regional Probe Alarm
resource "aws_cloudwatch_metric_alarm" "stale_probe" {
  alarm_name          = "${local.name}-stale-regional-probe"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "StaleProbesCount"
  namespace           = "Argus/Worker"
  period              = 60
  statistic           = "Maximum"
  threshold           = 0
  alarm_description   = "One or more regional probes have stale heartbeats for 2 consecutive periods"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Environment = var.environment
  }
}
