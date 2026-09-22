output "dev_url" {
  value = "https://${local.dev_fqdn}"
}

# Values for the GitHub `dev` environment's variables.
output "ci_env_variables" {
  value = {
    ECS_CLUSTER      = aws_ecs_cluster.main.name
    ECS_SERVICE      = aws_ecs_service.app.name
    MIGRATE_TASK_DEF = aws_ecs_task_definition.migrate.family
    MIGRATE_NETWORK_CONFIG = jsonencode({
      awsvpcConfiguration = {
        subnets        = aws_subnet.private[*].id
        securityGroups = [aws_security_group.app.id]
        assignPublicIp = "DISABLED"
      }
    })
    NEXT_PUBLIC_SUPABASE_URL      = var.supabase_url
    NEXT_PUBLIC_SUPABASE_ANON_KEY = var.supabase_anon_key
  }
}
