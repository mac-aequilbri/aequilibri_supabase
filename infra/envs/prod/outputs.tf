output "alb_dns_name" {
  description = "Smoke-test URL: http://<this>/api/health"
  value       = aws_lb.main.dns_name
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

# --- GitHub repo variables for deploy.yml (Settings → Actions → Variables) ---
output "ci_repo_variables" {
  value = {
    AWS_DEPLOY_ROLE_ARN = var.github_repo != "" ? aws_iam_role.ci_deploy[0].arn : "(set var.github_repo and re-apply)"
    ECR_REPOSITORY      = aws_ecr_repository.app.name
    ECS_CLUSTER         = aws_ecs_cluster.main.name
    ECS_SERVICE         = aws_ecs_service.app.name
    MIGRATE_TASK_DEF    = aws_ecs_task_definition.migrate.family
    MIGRATE_NETWORK_CONFIG = jsonencode({
      awsvpcConfiguration = {
        subnets        = aws_subnet.private[*].id
        securityGroups = [aws_security_group.app.id]
        assignPublicIp = "DISABLED"
      }
    })
  }
}

output "buckets" {
  value = { for k, b in aws_s3_bucket.app : k => b.bucket }
}

output "secret_name_prefix" {
  description = "Fill values with: aws secretsmanager put-secret-value --secret-id aequilibri/prod/<NAME> --secret-string '...'"
  value       = "aequilibri/prod/"
}

output "kms_key_arn" {
  value = aws_kms_key.main.arn
}
