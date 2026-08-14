# Infrastructure (Workstream A) — Terraform, ap-southeast-2

Implements [docs/aws-deployment-plan.md](../docs/aws-deployment-plan.md) as
amended 2026-08-13 (database tier = **Supabase Sydney**, so there is no RDS
here — DB traffic egresses via NAT over TLS). Beginner walkthrough:
[docs/aws-deployment-guide.md](../docs/aws-deployment-guide.md).

## Layout

```
bootstrap/    one-time: creates the Terraform state bucket (local state)
envs/prod/    the whole stack (S3 backend)
  baseline.tf       CloudTrail, GuardDuty, Config, Security Hub, account
                    S3 public-block, budget alerts
  network.tf        VPC 2×AZ, NAT, VPC endpoints, flow logs
  kms.tf            CMK for S3 + Secrets Manager
  s3.tf             documents / attachments / backups buckets
  ecr.tf            image repo (MUTABLE — see note in file)
  secrets.tf        Secrets Manager containers (values filled via CLI, never
                    through Terraform → nothing secret in state)
  iam.tf            execution / app-task / CI-OIDC roles
  alb.tf            ALB + SGs (HTTP-only until the domain is chosen)
  ecs.tf            cluster, app service (desired 0→1), migrate task def
  observability.tf  SNS + alarms (5xx, unhealthy target, crash-loop)
```

## Apply order

```bash
aws sso login --profile aequilibri-prod
cd infra/bootstrap && terraform init && terraform apply          # once
cd ../envs/prod    && terraform init && terraform plan           # review!
terraform apply
```

Then:

1. **Fill secrets** (containers exist, values don't):
   internal ones are generated (`openssl rand -base64 48`); third-party keys
   (Anthropic, Clerk, Supabase URLs) pasted by the owner:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id aequilibri/prod/CRON_SECRET \
     --secret-string "$(openssl rand -base64 48)"
   ```
   DB URLs come from `scripts/provision-core-supabase.mjs` output. Pooled
   URLs (`DATABASE_URL`, `CONTROL_DATABASE_URL`) must use the
   `aequilibri_app` role and end `?pgbouncer=true&connection_limit=5`;
   `DIRECT_URL`/`CONTROL_DIRECT_URL` are session-pooler `postgres` URLs and
   feed the migrate task only.
2. **GitHub repo exists** → set `github_repo = "<org>/<repo>"` in
   `terraform.tfvars`, re-apply, copy the `ci_repo_variables` output into the
   repo's Actions variables, push to main → CI builds, migrates, deploys.
3. First image is in ECR → set `app_desired_count = 1`, re-apply.
4. Smoke test: `http://$(terraform output -raw alb_dns_name)/api/health`.

## Deliberately deferred (do when the domain is chosen)

- ACM cert, :443 listener (TLS13-1-2 policy), 80→443 redirect, Route 53
  records, WAF (managed rules, start in count mode). **Until then the HTTP
  listener is for smoke-testing only — no real client traffic, and don't
  point n8n or EventBridge at it** (Bearer secrets over plain HTTP).
- EventBridge Scheduler → `/api/platform/scheduler` (needs the HTTPS URL).
- Weekly logical pg_dump task (needs Supabase URLs + backups bucket; add as
  a scheduled ECS task — plan §7).
- ECR back to IMMUTABLE once CI deploys by task-def revision instead of
  moving tags.

## Standing constraints (do not "fix")

- `desired_count` capped at 1 (validation enforces it): scheduler lock,
  proposal claim set and caches are per-process. Redis first, then scale.
- App runtime DB role must be `aequilibri_app` (NOBYPASSRLS). A `postgres`
  URL in a runtime secret silently disarms tenant RLS.
- All secret values are freshly generated; nothing from `.env` history.
