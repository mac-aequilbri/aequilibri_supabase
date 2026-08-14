# AWS deployment plan (Phase 7) — ap-southeast-2

**Status:** PLAN — written 2026-07-30, nothing provisioned.
**AMENDED 2026-08-13 (owner decision): Supabase replaces direct/RDS Postgres.**
The app still deploys to ECS Fargate in ap-southeast-2 per this plan, but the
database tier is **Supabase (Sydney region)** — one Supabase *project per
client org* (preserving §2b database-per-client), plus two core projects
(`aequilibri-control`, `aequilibri-t-default`). Provisioning goes through the
Supabase Management API (`scripts/_supabase.mjs`), not `CREATE DATABASE`.
Scope is database-only: Clerk stays for auth, S3 stays for documents, Prisma
stays the only DB client. RDS-specific text below (A3, parts of §1/§2/§7) is
superseded where it conflicts; amendments are marked inline.
**Supersedes** the Render-oriented parts of migration-plan Phase 7 and the
committed `render.yaml` (which is now reference-only; delete once AWS is live).
**Owner decision recorded:** the deployment environment is **AWS**, not Render
(2026-07-30). This resolves the plan's open decision 5 (host) and — because
every AWS component below lives in **ap-southeast-2 (Sydney)** — it also
resolves the app-and-data half of open decision 4: both compute and data are
AU-resident. What remains of decision 4 is third-party processing (§8).

The plan is grounded in this codebase's actual constraints:

| Constraint (verified in code) | Consequence for AWS |
|---|---|
| §2b topology: control DB + default tenant DB + one DB per client, provisioned by `scripts/provision-tenant-db.mjs` (Supabase project find-or-create + migrate + RLS pin), fan-out by `scripts/migrate-all-tenants.mjs` | *(amended 2026-08-13)* One **Supabase project per database** — two core projects + one per provisioned client; provisioning via the Management API (ops-only `SUPABASE_ACCESS_TOKEN`/`SUPABASE_ORG_ID`), no CREATEDB anywhere; migrations run as a release step over session-mode URLs |
| **Single instance only** — scheduler lock, proposal claim set, tenant-client LRU and caches are per-process (hardening audit; `numInstances: 1` pin) | ECS service `desiredCount: 1`, `maxPercent: 100` + `minHealthyPercent: 0` (stop-then-start deploys) — NO autoscaling until a shared Redis exists |
| Documents stored via `LocalFsStorer` at `process.cwd()/var/storage` (Google Drive optional) | Container filesystems are ephemeral → **S3 storer adapter** (small code item, §5.1) or interim EFS mount; S3 preferred (AU bucket, versioned, lifecycle) |
| Scheduler is an HTTP endpoint (`/api/platform/scheduler`, `CRON_SECRET`) | **EventBridge Scheduler** hits it hourly — no in-cluster cron |
| n8n Cloud polls `GET/POST /api/platform/outbox` (Bearer) and posts inbound webhooks | The ALB endpoint must be public HTTPS; secrets via Secrets Manager |
| Boot guard requires `DATABASE_URL` + `CONTROL_DATABASE_URL`; both Prisma clients generated at build | Dockerfile runs `npm run db:generate`; task env injects both URLs from Secrets Manager |
| Native RLS org-pins are **inert for superusers/BYPASSRLS** (Phase 3 caveat) | *(amended)* Supabase's built-in `postgres` role can bypass RLS → runtime URLs carry a dedicated **`aequilibri_app` role (NOBYPASSRLS)**, bootstrapped and verified by `scripts/_supabase.mjs`; `postgres` is used only for migrations/ops |
| Next 16, no `output: "standalone"` yet | Add standalone output for a small image (§5.2) |

---

## 1. Target architecture (all ap-southeast-2)

```
Route53 (app domain)
  → ALB (ACM cert, HTTPS only, HTTP→HTTPS redirect)
    → ECS Fargate service "aequilibri-app" (1 task, private subnets)
        image: ECR ← GitHub Actions (OIDC, no long-lived keys)
        env: Secrets Manager → task definition secrets
        egress via NAT: Anthropic API, Clerk, n8n Cloud, Google APIs,
                        Airtable (transition window only)
    → (one-off ECS task, same image) "migrate" — runs
        node scripts/migrate-all-tenants.mjs before each release
Supabase (Sydney) — one project per database   (amended 2026-08-13; was RDS)
  aequilibri-control · aequilibri-t-default · aequilibri-t-<slug> per client
  runtime:  Supavisor transaction pooler :6543, role aequilibri_app,
            ?pgbouncer=true&connection_limit=5
  CLI/ops:  Supavisor session pooler :5432, role postgres (migrate, pg_dump)
  (public TLS endpoints — app egress via NAT; the "no public DB" posture of
   the RDS design is replaced by role separation + strong passwords + TLS)
S3:  <org>-aequilibri-documents   (document storer; versioned)
     <org>-aequilibri-attachments (migration binaries + manifests)
     <org>-aequilibri-backups     (logical dumps; see §7)
EventBridge Scheduler → https://<app>/api/platform/scheduler (hourly, CRON_SECRET header)
CloudWatch: container logs, RDS metrics, alarms (§7)
```

VPC: 2 AZs, public subnets (ALB, NAT) + private subnets (ECS). *(amended)*
No RDS — the database tier is Supabase; DB traffic leaves via NAT to the
Supabase Sydney endpoints over TLS.

## 2. Sizing / cost ballpark (monthly, Sydney, current published pricing — verify at provisioning)

*(amended 2026-08-13)* Fargate 1 vCPU/2GB ≈ US$36 · NAT gateway ≈ US$37 +
data · ALB ≈ US$25 · S3/Route53/CloudWatch ≈ US$5–15 · **Supabase: Pro org
US$25 + ~US$10/mo compute per additional project** — control + default +
2 live client projects ≈ US$55; each newly provisioned client +~US$10.
**Order of US$160–180/mo at today's tenant count**, growing ~US$10 per
provisioned client. (NAT is the silly-but-unavoidable line item; an
egress-heavy month moves it.)

## 3. Environments

One production environment first; a `staging` copy (same template, smaller
RDS) once the client is live. Local dev stays as-is (local PG cluster).
Account layout assumed: a single dedicated AWS account for this product
(create it if the org currently has none — do not co-tenant with unrelated
workloads); region locked to ap-southeast-2 via SCP or at least convention.

## 4. Workstream A — AWS foundation (infra as code)

Use **Terraform** (or CDK if the owner prefers TypeScript end-to-end — decide
at kickoff; steps identical):

- A1. Account bootstrap: IAM identity centre user(s), billing alerts,
  CloudTrail on, region ap-southeast-2.
- A2. VPC module (2 AZ, public/private, NAT, VPC endpoints for S3/ECR/
  Secrets Manager/CloudWatch to cut NAT traffic).
- A3. *(amended 2026-08-13 — was RDS)* **Supabase org + core projects**:
  Supabase Pro org (Sydney), personal access token generated and held as
  ops-only secrets (`SUPABASE_ACCESS_TOKEN`, `SUPABASE_ORG_ID` — never app
  runtime env). Run `scripts/provision-core-supabase.mjs` to create
  `aequilibri-control` + `aequilibri-t-default`, bootstrap the runtime role
  and print the four Secrets Manager URLs. Role model per project:
  Supabase's `postgres` (admin; migrations, RLS pin, dumps — session pooler
  :5432) and `aequilibri_app` (NOBYPASSRLS; the only role in runtime URLs —
  transaction pooler :6543, `?pgbouncer=true`). NOTE:
  `provision-tenant-db.mjs` creates per-client projects via the Management
  API — from the ops runbook, NOT from the app task.
- A4. S3 buckets (versioning, SSE-S3, public access blocked, lifecycle:
  attachments → IA after 90d).
- A5. ECR repo + lifecycle policy (keep last 10 images).
- A6. Secrets Manager entries: DATABASE_URL, CONTROL_DATABASE_URL,
  DIRECT_URL, CONTROL_DIRECT_URL *(amended: the pooled pair feeds the app
  task; all four feed the migrate task)*,
  ANTHROPIC_API_KEY, Clerk prod keys, PLATFORM_ENCRYPTION_KEY (fresh),
  CRON_SECRET, PLATFORM_WEBHOOK_SECRET, OUTBOX_FEED_SECRET, IMAP_*,
  Google/Xero/Geoscape as needed. **All fresh values** — the hardening audit
  required rotation, and the dev `.env` values in this repo's history are
  burned by definition.
- A7. ALB + ACM cert + Route53 records; security groups (ALB→app:3000;
  *(amended)* DB egress is NAT→Supabase Sydney over TLS :5432/:6543 — no
  RDS security group).
- A8. ECS cluster, task definition (see §5.2), service (desiredCount 1,
  stop-then-start), one-off migrate task definition.
- A9. EventBridge Scheduler rule → scheduler endpoint (hourly) with
  `Authorization: Bearer <CRON_SECRET>`.

Exit: `terraform apply` from zero brings up the stack; app task boots against
empty DBs and `/api/health` returns ok behind the ALB.

## 5. Workstream B — codebase items (small, this repo)

- B1. **S3 document storer** (`src/lib/platform/storage.ts`): third provider
  `s3` alongside `local`/`gdrive` — `@aws-sdk/client-s3`, bucket + key prefix
  from env (`DOCUMENTS_BUCKET`), task-role auth (no keys). Selection stays
  env-driven; `storageProvider` column already exists per document. Include a
  one-shot `scripts/migrate-local-storage-to-s3.mjs` for anything in
  `var/storage` (dev/staging artifacts; production starts on S3).
- B2. **Dockerfile** (multi-stage): deps → `npm run db:generate` + build with
  `output: "standalone"` (add to next.config; keep `serverExternalPackages`
  natives — copy `@napi-rs/canvas`/`geotiff` into the runtime layer) → slim
  `node:24-slim` runtime, non-root user, port 3000. Plus `.dockerignore`.
- B3. **Migrate entrypoint**: the same image runs
  `node scripts/migrate-all-tenants.mjs` as the release task (script already
  fail-fast + re-pins RLS).
- B4. **Health**: extend `/api/health` with cheap DB probes (control +
  default tenant `SELECT 1`) for the ALB target-group check.
- B5. **GitHub Actions**: on push to main — typecheck, vitest, build image,
  push ECR (OIDC role), run migrate task, `aws ecs update-service
  --force-new-deployment`. Requires open decision 5's **new GitHub repo**
  (this working copy still has NO remote — first push happens here).
- B6. Delete `render.yaml` once the ECS deploy is proven.

Exit: image runs locally (`docker run` against the local cluster), CI green
end-to-end into a staging service.

**Status 2026-08-09 — B1–B5 code-complete (Docker unavailable on the dev
box; image build itself verifies on AWS week):**
- B1 ✅ `lib/platform/s3storage.ts` (provider "s3", DOCUMENTS_BUCKET/_PREFIX,
  default credential chain, full-key refs) + `scripts/
  migrate-local-storage-to-s3.mjs` (--dry-run / --update-refs across default
  + provisioned tenant DBs). Selection order: s3 → gdrive → local.
- B2 ✅ `output: "standalone"` in next.config; multi-stage Dockerfile on
  node:24-slim (openssl for Prisma engines, non-root, build-time placeholder
  DB URLs — the boot guard warns, not throws). VERIFIED locally without
  Docker: `next build` produces standalone output (171 MB) containing
  server.js, BOTH generated Prisma clients and the @napi-rs/geotiff
  natives, and the standalone server boots and serves /api/health green
  against the real local databases.
- B3 ✅ (one amendment to the plan) the migrate release task is a SECOND
  TARGET of the same Dockerfile (`--target migrate`), not the runner image:
  the standalone output deliberately lacks the prisma CLI that
  migrate-all-tenants.mjs needs. Same build, shared layers, two tags.
- B4 ✅ /api/health now probes control + default tenant DBs (SELECT 1,
  3s time-box each) alongside the auth-config check.
- B5 ✅ `.github/workflows/deploy.yml` — test job (Postgres 16 service,
  both schemas migrated, typecheck + vitest) runs from the first push; the
  deploy job (OIDC → ECR → both targets → migrate run-task fail-fast →
  force-new-deployment) is gated on repo variables Workstream A fills, so
  CI is green before the AWS account exists. Still blocked on the GitHub
  remote (open decision 5's repo).
- B6 pending as planned (delete render.yaml once ECS is proven).

## 6. Workstream C — data + cutover (maps to migration-plan Phase 7.5)

- C1. *(amended 2026-08-13)* Provision prod DBs: `provision-core-supabase.mjs`
  for control + default, then `provision-tenant-db.mjs` (Management API,
  ops runbook) for meridian-legal and dulong-downs-didi;
  `seed-control-plane.mjs` for catalogs. Existing tenant data moves by
  `pg_dump -Fc --no-owner --no-acl` → `pg_restore` into the empty project
  over the session pooler, then re-run grants + RLS pin (restored tables
  predate the default privileges), then registry URLs (pooled + direct)
  at activation.
- C2. Full mover runs against prod Supabase (`--target-url` = session URL),
  attachments script (`--apply-refs`), verification report v2 (same format
  as `docs/migration-verification-2026-07-29.md`).
- C3. Cutover: **freeze Airtable writes** (client comms!) → final incremental
  mover run (idempotent on `airtableRecordId`) → verify counts → DNS switch →
  Airtable read-only for the agreed retention window → final export to the
  backups bucket → close workspace.
- C4. Post-cutover: revoke the Airtable PAT; keep `pg-to-airtable.mjs` per
  the owner's (still-pending) decision 3.
- C5. The client-facing conversation from §2b — Didi loses direct base
  access; what replaces it (portal/exports) — must be DONE before C3.

## 7. Security / backup / ops checklist (the audit Criticals)

- *(amended 2026-08-13)* Supabase Pro daily backups (7d retention) per
  project replace RDS snapshots; PITR is a per-project paid add-on — enable
  per client on request. KEEP the weekly logical `pg_dump` of EVERY
  database (control + each tenant, over the session pooler) to the backups
  bucket via a scheduled ECS task — logical dumps are the per-tenant
  offboarding/restore artifact §2b promises. `pg_dump` client version must
  match Supabase's PG major. Test a restore before go-live.
- App DB role is `aequilibri_app`, NOBYPASSRLS-verified at provisioning
  (makes the tenant RLS org-pins real); a runtime URL built with the
  `postgres` role would silently disarm them — grep-audit registry URLs at
  cutover.
- Pooled URLs MUST carry `?pgbouncer=true` (transaction pooler has no
  prepared statements; missing param = intermittent "prepared statement
  s0 already exists" errors).
- **Supabase auto-enables policy-less RLS on every new table in `public`**
  (verified 2026-08-13: it default-denies `aequilibri_app`, so every write
  fails with 42501). Provisioning and migrate fan-out clear it
  automatically (`clearAutoEnabledRls` in `scripts/_supabase.mjs`); after a
  manual `pg_restore` run `scripts/supabase-clear-auto-rls.mjs` (with
  `--keep-org-tables` on per-client tenant DBs, then re-pin).
- CloudWatch alarms: task crash-loop, ALB 5xx, RDS storage/CPU, scheduler
  failures (the endpoint logs a summary row per run).
- Secrets rotation schedule; PLATFORM_ENCRYPTION_KEY set BEFORE any Xero/
  Drive connection is stored.
- Single task ≠ zero downtime deploys (stop-then-start): deploys are a
  ~60–90s blip; acceptable at this scale, revisit with Redis + 2 tasks later.

## 8. Residency — what AWS does NOT solve (client sign-off needed)

Data at rest and app compute: **AU (Sydney), done** — *(amended 2026-08-13)*
database-at-rest is now **Supabase, Sydney region**: data stays in
ap-southeast-2, but Supabase Inc. is a US-headquartered third-party
processor with operator access — add it to the client sign-off list.
Still processing outside
AU: **Anthropic API** (assistant/AI features), **Clerk** (auth; user PII),
**n8n Cloud** (EU-hosted; email payloads transit it), Google Drive/Xero if
enabled. Options if the client requires AU processing: Anthropic via AWS
**Bedrock in ap-southeast-2** (Claude models; code change: swap the direct
API client), self-hosted n8n on the same ECS cluster, Clerk has no AU
residency (alternative: keep — auth metadata only — or replace; bigger
change). **Ask the client which of these need to move; do not assume.**

## 9. Sequence + estimate

1. A1–A7 foundation (2–3 days) → 2. B1–B4 code items (2–3 days, parallel) →
3. A8–A9 + B5 CI/CD into staging (1–2 days) → 4. C1–C2 prod data + verify
(1–2 days) → 5. soak + C5 client conversation (owner-paced) → 6. C3 cutover
(half day, scheduled window). **≈ 1.5–2 engineering weeks** plus owner/client
dependencies.

## Open items for the owner before work starts
1. Terraform vs CDK preference.
2. The new GitHub repo (name/org) — needed for CI/CD (open decision 5's
   remaining half).
3. App domain name (for ACM/Route53).
4. §8 third-party processing: which (if any) must move onshore — Bedrock
   swap? self-hosted n8n? Clerk stance?
5. Still pending from Phase 6: keep or delete `pg-to-airtable.mjs` (decision 3).
