resource "aws_ecs_cluster" "main" {
  name = "aequilibri"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/aequilibri-app"
  retention_in_days = 90
}

locals {
  ecr_url = aws_ecr_repository.app.repository_url

  app_secrets = [
    for name in local.app_secret_names : {
      name      = name
      valueFrom = aws_secretsmanager_secret.app[name].arn
    }
  ]
  migrate_secrets = [
    for name in local.migrate_secret_names : {
      name      = name
      valueFrom = aws_secretsmanager_secret.app[name].arn
    }
  ]
}

# --- App task ------------------------------------------------------------------
resource "aws_ecs_task_definition" "app" {
  family                   = "aequilibri-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  container_definitions = jsonencode([
    {
      name      = "aequilibri-app"
      image     = "${local.ecr_url}:${var.app_image_tag}"
      essential = true
      portMappings = [
        { containerPort = 3000, protocol = "tcp" }
      ]
      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = "3000" },
        { name = "DOCUMENTS_BUCKET", value = aws_s3_bucket.app["documents"].bucket },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", value = var.clerk_publishable_key },
        { name = "PLATFORM_ADMIN_EMAILS", value = var.platform_admin_emails }
      ]
      secrets = local.app_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "app"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "app" {
  name            = "aequilibri-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  launch_type     = "FARGATE"

  # Single-instance pin (per-process scheduler lock / caches): stop-then-start
  # deploys, ~60-90s blip. Do not change without a shared Redis.
  desired_count                      = var.app_desired_count
  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0

  health_check_grace_period_seconds = 60
  enable_execute_command            = true

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "aequilibri-app"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.http]
}

# --- Migrate one-off task (run by CI before each deploy) -------------------------
resource "aws_ecs_task_definition" "migrate" {
  family                   = "aequilibri-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.task_execution.arn
  # No task role: the migrate container needs nothing but its DB URLs.

  container_definitions = jsonencode([
    {
      name      = "aequilibri-migrate"
      image     = "${local.ecr_url}:${var.migrate_image_tag}"
      essential = true
      environment = [
        { name = "NODE_ENV", value = "production" }
      ]
      secrets = local.migrate_secrets
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "migrate"
        }
      }
    }
  ])
}
