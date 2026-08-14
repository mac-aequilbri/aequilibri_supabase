# Secret CONTAINERS only — values are set OUTSIDE Terraform (CLI:
# `aws secretsmanager put-secret-value`) so no secret material ever enters
# the state file. All values must be freshly generated (hardening audit:
# every value in the repo's .env history is burned).
#
# Pooled URLs (DATABASE_URL/CONTROL_DATABASE_URL, Supavisor :6543) MUST end
# with ?pgbouncer=true&connection_limit=5 and use the aequilibri_app role.
# DIRECT_URL/CONTROL_DIRECT_URL (session :5432, postgres role) feed only the
# migrate task.

locals {
  app_secret_names = [
    "DATABASE_URL",         # pooled, aequilibri_app
    "CONTROL_DATABASE_URL", # pooled, aequilibri_app
    "ANTHROPIC_API_KEY",
    "CLERK_SECRET_KEY",
    "PLATFORM_ENCRYPTION_KEY",
    "CRON_SECRET",
    "PLATFORM_WEBHOOK_SECRET",
    "OUTBOX_FEED_SECRET",
  ]
  migrate_secret_names = [
    "DATABASE_URL",
    "CONTROL_DATABASE_URL",
    "DIRECT_URL",         # session, postgres — migrate/ops only
    "CONTROL_DIRECT_URL", # session, postgres — migrate/ops only
  ]
  all_secret_names = distinct(concat(local.app_secret_names, local.migrate_secret_names))
}

resource "aws_secretsmanager_secret" "app" {
  for_each                = toset(local.all_secret_names)
  name                    = "aequilibri/prod/${each.key}"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}
