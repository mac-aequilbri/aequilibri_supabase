# Secret containers only (values via CLI, nothing in state) — dev namespace,
# ALL fresh values; prod credentials never reused (interim exception:
# ANTHROPIC_API_KEY copied from prod until a dedicated dev key is minted).
locals {
  app_secret_names = [
    "DATABASE_URL",         # pooled, aequilibri_app, t-default-dev
    "CONTROL_DATABASE_URL", # pooled, aequilibri_app, control-dev
    "ANTHROPIC_API_KEY",
    "SUPABASE_SERVICE_ROLE_KEY", # control-dev project
    "PLATFORM_ENCRYPTION_KEY",
    "CRON_SECRET",
    "PLATFORM_WEBHOOK_SECRET",
    "OUTBOX_FEED_SECRET",
  ]
  migrate_secret_names = [
    "DATABASE_URL",
    "CONTROL_DATABASE_URL",
    "DIRECT_URL",
    "CONTROL_DIRECT_URL",
  ]
  all_secret_names = distinct(concat(local.app_secret_names, local.migrate_secret_names))
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = toset(local.all_secret_names)
  name                    = "aequilibri/dev/${each.key}"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 0 # dev secrets are disposable
}
