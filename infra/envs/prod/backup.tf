# Weekly logical backups (plan §7): EventBridge Scheduler runs the ops image
# (migrate target, which carries pg_dump 17) with the backup script every
# Monday 03:00 AEST. Dumps land in the backups bucket (versioned, CMK,
# Glacier after 30d). A log metric filter alarms on "BACKUP FAILED".

# --- Task role: write dumps to the backups bucket only ------------------------
resource "aws_iam_role" "backup_task" {
  name               = "${var.name_prefix}-backup-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy" "backup_task" {
  name = "backups-bucket-write"
  role = aws_iam_role.backup_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.app["backups"].arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey", "kms:Decrypt"]
        Resource = aws_kms_key.main.arn
      }
    ]
  })
}

# --- Task definition (same ops image as migrate, different command) -----------
resource "aws_ecs_task_definition" "backup" {
  family                   = "aequilibri-backup"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.backup_task.arn

  container_definitions = jsonencode([
    {
      name      = "aequilibri-backup"
      image     = "${local.ecr_url}:${var.migrate_image_tag}"
      essential = true
      command   = ["node", "scripts/backup-all-tenants.mjs"]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "BACKUPS_BUCKET", value = aws_s3_bucket.app["backups"].bucket }
      ]
      secrets = local.migrate_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "backup"
        }
      }
    }
  ])
}

# --- Scheduler role + weekly schedule ------------------------------------------
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name_prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  name = "run-backup-task"
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = "arn:aws:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:task-definition/aequilibri-backup:*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.task_execution.arn, aws_iam_role.backup_task.arn]
        Condition = {
          StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" }
        }
      }
    ]
  })
}

resource "aws_scheduler_schedule" "weekly_backup" {
  name = "${var.name_prefix}-weekly-backup"

  flexible_time_window {
    mode = "OFF"
  }

  # 17:00 Sunday UTC = 03:00 Monday AEST
  schedule_expression = "cron(0 17 ? * SUN *)"

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.backup.arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.app.id]
        assign_public_ip = false
      }
    }

    retry_policy {
      maximum_retry_attempts = 1
    }
  }
}

# --- Alarm on any failed backup -------------------------------------------------
resource "aws_cloudwatch_log_metric_filter" "backup_failed" {
  name           = "${var.name_prefix}-backup-failed"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = "\"BACKUP FAILED\""
  metric_transformation {
    name          = "BackupFailed"
    namespace     = "Aequilibri"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "backup_failed" {
  alarm_name          = "${var.name_prefix}-backup-failed"
  alarm_description   = "A weekly pg_dump backup reported failure (see 'backup' log streams)"
  namespace           = "Aequilibri"
  metric_name         = "BackupFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alarms.arn]
}
