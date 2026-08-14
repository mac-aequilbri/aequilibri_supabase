# AWS deployment guide — step by step, for a first-time AWS operator

**Companion to:** [aws-deployment-plan.md](aws-deployment-plan.md) (Phase 7).
That document says *what* and *why*; this one says *how*, in order, assuming
you have never provisioned anything on AWS before. Everything lives in
**ap-southeast-2 (Sydney)**.

**Security stance:** every step below follows an enterprise baseline —
no root usage, no long-lived access keys, MFA everywhere, everything private
by default, encryption at rest with customer-managed KMS keys, full audit
trail (CloudTrail + Config + GuardDuty), least-privilege IAM roles. Items
that go *beyond* the plan doc are marked **[security add-on]** so you can see
what was layered in.

**Before you start — the plan's open decisions must be answered:**

1. **Terraform vs CDK.** This guide assumes **Terraform** (the plan's
   default). If you pick CDK the steps are identical in substance.
2. **GitHub repo** — this working copy has NO remote yet. CI/CD (Part 12)
   needs the repo to exist first.
3. **App domain name** — needed for the TLS certificate (Part 8).
4. **§8 residency choices** (Bedrock? self-hosted n8n? Clerk?) — affects
   Parts 7 and 9 only marginally; can be decided during the soak period, but
   ask the client early.

---

## Part 0 — A five-minute glossary

You'll meet these names constantly. Plain-English versions:

| Term | What it actually is |
|---|---|
| **Region / AZ** | Region = a city's worth of data centres (Sydney = `ap-southeast-2`). AZ (Availability Zone) = one independent data centre inside it. We use 2 AZs. |
| **VPC** | Your private network inside AWS. Nothing outside can reach anything in it unless you explicitly open a door. |
| **Subnet** | A slice of the VPC. "Public" subnets can face the internet; "private" subnets cannot be reached from it. |
| **Security group** | A firewall attached to a resource. Default: block everything; you add narrow allow-rules. |
| **NAT gateway** | Lets things in *private* subnets make *outbound* calls (to the Anthropic API, Clerk, n8n) without being reachable inbound. |
| **ECS Fargate** | Runs your Docker container without you managing any server. A "task" = one running copy of the container; a "service" keeps N tasks alive (for us N = 1). |
| **ECR** | AWS's private Docker image registry. CI pushes images here; ECS pulls from here. |
| **RDS** | Managed PostgreSQL. AWS handles the OS, backups, and patching; you get an endpoint and credentials. |
| **ALB** | Application Load Balancer — the public HTTPS front door that forwards requests to the ECS task. |
| **ACM** | Free, auto-renewing TLS certificates (used by the ALB). |
| **Route 53** | DNS — points your domain at the ALB. |
| **S3** | Object (file) storage in buckets. |
| **Secrets Manager** | Encrypted store for secrets; ECS injects them into the container as env vars at start-up. Secrets never live in code or task definitions. |
| **KMS** | The encryption-key service. A "customer-managed key" (CMK) is one you own, can audit, and can revoke. |
| **IAM role** | An identity that AWS services *assume* to get permissions. No passwords, no keys — this is how the app talks to S3 without any credential in env. |
| **Terraform** | Tool that reads `.tf` files describing infrastructure and makes AWS match them. Everything below (except Part 1's one-time account setup) is Terraform-managed. |

---

## Part 1 — Account foundation and security baseline (plan A1)

One-time, mostly console work. **Do not skip anything here** — this is the
part that makes everything after it enterprise-grade.

### 1.1 Create the dedicated AWS account
The plan requires a **single dedicated account** for this product — no
co-tenanting.

1. Go to `aws.amazon.com` → *Create an AWS Account*. Use a **role-based
   email** (e.g. `aws-aequilibri@aequilibri.com`, ideally a group/alias, not
   one person's inbox) — this address IS the root user forever.
2. Business account details, credit card, phone verification. Choose the
   **Sydney** region when asked for a default.

### 1.2 Lock down the root user (do this immediately)
The root user can do anything and cannot be restricted. Enterprise rule:
**configure it, MFA it, then never use it again.**

1. Sign in as root → *Security credentials*.
2. **Enable MFA** — a hardware key (YubiKey) is the enterprise choice; an
   authenticator app is acceptable minimum. **[security add-on:** register
   *two* MFA devices for root so a lost key isn't a lockout.**]**
3. Verify root has **no access keys** (there's a section on the same page —
   it should be empty; if any exist, delete them).
4. Set the account's **alternate contacts** (billing/operations/security) to
   real, monitored addresses.
5. Log out of root. From here on you use root only for the ~5 tasks AWS
   reserves for it (closing the account, changing support plans, etc.).

### 1.3 Create your daily-use identity (IAM Identity Center)
Never create classic IAM users with passwords/access keys. Use **IAM
Identity Center** (SSO) — short-lived credentials, central MFA.

1. Console → *IAM Identity Center* → Enable (choose ap-southeast-2).
2. Create a user for yourself (and each engineer later).
3. Create a **permission set**: start from the AWS-managed
   `AdministratorAccess` for the person running Terraform (you), and a
   `ReadOnlyAccess` set for anyone who only needs to look.
4. Assign user → account → permission set.
5. **Enforce MFA**: Identity Center → Settings → Authentication →
   *Require MFA every time they sign in* (or at minimum on new devices).
6. Note your **AWS access portal URL** (like
   `https://d-xxxxxxxxxx.awsapps.com/start`) — that's how you log in from
   now on, both in the browser and the CLI.

### 1.4 Turn on the audit and threat-detection layer
All console, all in ap-southeast-2, all ~5 minutes each:

1. **CloudTrail** (required by plan A1): create a trail, *apply to all
   regions*, logging to a dedicated S3 bucket, **log file validation on**.
   This is the immutable record of every API call in the account.
2. **[security add-on] GuardDuty**: one-click enable. Managed threat
   detection (compromised credentials, crypto-mining, port scans). Almost
   free at this scale.
3. **[security add-on] AWS Config**: enable, all resources. Records every
   configuration change — "who opened that security group and when."
4. **[security add-on] Security Hub**: enable with the **AWS Foundational
   Security Best Practices** standard. It continuously grades the account
   and gives you a findings list; treat CRITICAL/HIGH findings as work items.
5. **[security add-on] Account-level S3 Block Public Access**: S3 console →
   *Block Public Access settings for this account* → block all four. No
   bucket in this account can ever be made public, even by mistake.
6. **[security add-on] Default EBS encryption**: EC2 console → Account
   attributes → enable "Always encrypt new EBS volumes".

### 1.5 Billing guardrails
1. Billing console → Budgets → create a monthly budget at the plan's
   ballpark (~US$200) with alert emails at 50/80/100%.
2. Enable *Cost Explorer*.

### 1.6 Region lock
The plan says "SCP or at least convention". A Service Control Policy needs
AWS Organizations; if this stays a standalone account, the honest minimum is:

- **[security add-on]** Add an explicit deny-outside-Sydney statement to the
  Terraform execution role later (Part 2.3), and rely on Security Hub/Config
  to flag stray-region resources. If you later put the account in an
  Organization, apply a real SCP denying all actions where
  `aws:RequestedRegion` is not `ap-southeast-2` (with the usual exemptions
  for global services: IAM, CloudFront, Route 53, ACM-for-CloudFront).

**Exit criteria for Part 1:** you can sign in via the Identity Center portal
with MFA; root is MFA'd and unused; CloudTrail/GuardDuty/Config/Security Hub
all show "recording/enabled"; a budget alert exists.

---

## Part 2 — Your workstation tooling

1. **Install AWS CLI v2** (winget: `winget install Amazon.AWSCLI`).
2. **Log in via SSO** — no access keys ever:
   ```
   aws configure sso
   # SSO start URL: your access-portal URL
   # SSO region:    ap-southeast-2
   # profile name:  aequilibri-prod
   aws sso login --profile aequilibri-prod
   aws sts get-caller-identity --profile aequilibri-prod   # sanity check
   ```
3. **Install Terraform** (`winget install Hashicorp.Terraform`) and
   **Docker Desktop** (for building/testing the image locally, Part 11).
4. **Terraform remote state** — the one chicken-and-egg piece you create by
   hand (console or CLI):
   - S3 bucket `aequilibri-terraform-state` (versioning ON, SSE-KMS,
     public access blocked — it will contain your infrastructure's full
     description, treat it as sensitive).
   - S3 native state locking (Terraform ≥1.10 `use_lockfile`) or a DynamoDB
     lock table for older workflows.
   Then every Terraform root module uses:
   ```hcl
   terraform {
     backend "s3" {
       bucket       = "aequilibri-terraform-state"
       key          = "prod/terraform.tfstate"
       region       = "ap-southeast-2"
       use_lockfile = true
     }
   }
   ```

Repository layout suggestion (new `infra/` directory in the new GitHub repo,
or its own repo — owner's call):

```
infra/
  modules/  vpc/  rds/  s3/  ecs/  alb/  ...
  envs/prod/ main.tf  variables.tf  terraform.tfvars
```

From here on, each Part = one Terraform module you write, then
`terraform plan` (review!) and `terraform apply`.

---

## Part 3 — Network: the VPC (plan A2)

What you're building: 2 AZs; public subnets hold only the ALB and the NAT
gateway; private subnets hold ECS and RDS. Nothing private is reachable from
the internet, ever.

1. VPC CIDR e.g. `10.20.0.0/16`; per AZ one public (`10.20.0.0/24`,
   `10.20.1.0/24`) and one private (`10.20.10.0/24`, `10.20.11.0/24`) subnet.
2. Internet gateway → route for public subnets.
3. **One NAT gateway** (in AZ-a public subnet) → default route for private
   subnets. (Two NATs is the HA pattern; at one task/single-AZ RDS it's
   wasted money — note it as the thing you add when you scale.)
4. **VPC endpoints** (plan A2 — cuts NAT cost AND keeps AWS-bound traffic
   off the internet entirely):
   - Gateway endpoint: **S3** (free).
   - Interface endpoints: **ECR (api + dkr)**, **Secrets Manager**,
     **CloudWatch Logs**. Each gets its own security group allowing 443
     from the app's security group only.
5. **[security add-on] VPC Flow Logs** → CloudWatch Logs (or S3), so you
   have a record of all network flows for incident forensics.
6. The default security group of the VPC: strip all rules (Terraform
   `aws_default_security_group` with no ingress/egress) so nothing can
   accidentally use it.

---

## Part 4 — Database: Supabase, Sydney region (plan A3, amended 2026-08-13)

**Owner decision 2026-08-13: Supabase replaces RDS.** One Supabase *project*
per database — `aequilibri-control`, `aequilibri-t-default`, and
`aequilibri-t-<slug>` per client — preserving the §2b database-per-client
topology. Everything below happens in the Supabase dashboard/API, not
Terraform.

1. **Create a Supabase Pro organisation** (supabase.com), region for every
   project: **ap-southeast-2 (Sydney)**. Pro is required for daily backups
   and support; each project beyond the first adds ~US$10/mo compute.
2. **Generate a personal access token** (dashboard → Access Tokens) for the
   Management API. Store as `SUPABASE_ACCESS_TOKEN` + `SUPABASE_ORG_ID` —
   **ops-only** (your ops shell / optionally Secrets Manager); the app task
   never sees them.
3. **Stand up the two core projects**: from the repo, with the token in env,
   `node scripts/provision-core-supabase.mjs`. It creates both projects,
   bootstraps the runtime role, runs both migration histories, and prints
   the four URLs for Part 7. Per-client projects come later via
   `scripts/provision-tenant-db.mjs` (Part 13).
4. **The two-role split** (this is what makes the app's RLS real — the
   plan's Phase 3 caveat: org-pins are inert for BYPASSRLS roles, and
   Supabase's built-in `postgres` role can bypass RLS):
   - `postgres` — Supabase's admin role (password chosen at project
     creation; the scripts print it ONCE — store it in Secrets Manager
     immediately, it is not retrievable). Runs migrations, RLS pins,
     `pg_dump`. **Session pooler, port 5432.** Used only by the migrate
     task and the ops runbook.
   - `aequilibri_app` — created by `scripts/_supabase.mjs` with
     `NOBYPASSRLS NOCREATEDB NOCREATEROLE` and verified
     (`rolbypassrls = false`) on every provisioning run. This is the only
     role in the app task's URLs. **Transaction pooler, port 6543, with
     `?pgbouncer=true&connection_limit=5`** (prepared statements off —
     required by the pooler; Prisma migrations go through `directUrl`).
   Never store or use the `db.<ref>.supabase.co` direct host — it is
   IPv6-only without a paid add-on and unreachable from GitHub runners and
   an IPv4-only VPC. Always the pooler host.
5. **Network posture**: unlike RDS-in-private-subnets, Supabase endpoints
   are public TLS. Compensating controls: strong generated passwords, the
   role split above, TLS everywhere, and (optional, Pro) Supabase network
   restrictions pinned to the NAT gateway's EIP once the VPC exists.
6. **Auto-enabled RLS gotcha** (verified 2026-08-13): Supabase enables
   policy-less RLS on every new table in `public` — which default-denies
   `aequilibri_app`; every write fails with 42501. The provisioning scripts
   and the migrate fan-out clear it automatically; after any manual
   `pg_restore`, run `scripts/supabase-clear-auto-rls.mjs` (add
   `--keep-org-tables` on per-client tenant DBs, then re-run the RLS pin).

---

## Part 5 — S3 buckets (plan A4)

Three buckets (S3 names are global — prefix with the org, e.g.
`aequilibri-prod-documents`):

| Bucket | Purpose | Extras |
|---|---|---|
| `…-documents` | app document storage (B1 storer) | versioning ON |
| `…-attachments` | migration binaries + manifests | lifecycle: → Infrequent Access after 90d |
| `…-backups` | weekly logical pg_dumps, final Airtable export | **[security add-on]** lifecycle to Glacier after 30d; consider Object Lock (governance mode) so backups can't be silently deleted |

For each bucket, uniformly:
- All four public-access blocks ON (redundant with the account-level block
  from 1.4 — defence in depth).
- **[security add-on]** Encryption with a customer-managed KMS key
  (`alias/aequilibri-s3`) rather than plain SSE-S3.
- **[security add-on]** Bucket policy that denies non-TLS requests
  (`aws:SecureTransport = false` → Deny).
- **[security add-on]** S3 server access logging (or CloudTrail data events)
  on the documents bucket — who read which client document, when.

---

## Part 6 — ECR: the image registry (plan A5)

1. One repo `aequilibri-app`. `image_tag_mutability = "IMMUTABLE"`
   **[security add-on]** — a tag can never be silently repointed; deploys are
   by digest-stable tags (we tag with the git SHA).
2. **Scan on push = ON** (basic scanning is free; Inspector-enhanced if you
   want continuous re-scanning) **[security add-on]** — CVE report for every
   image before it ships.
3. Lifecycle policy: keep last 10 images (plan A5).

---

## Part 7 — Secrets Manager (plan A6)

Rules first:
- **Every value is freshly generated.** The hardening audit burned the dev
  `.env` values — nothing from this repo's history goes to prod. That means:
  new Anthropic key, new Clerk *production* instance keys, fresh
  `PLATFORM_ENCRYPTION_KEY`, fresh random `CRON_SECRET`,
  `PLATFORM_WEBHOOK_SECRET`, `OUTBOX_FEED_SECRET`, new IMAP app password.
- `PLATFORM_ENCRYPTION_KEY` must be set **before** any Xero/Drive connection
  is stored (plan §7) — it can't be rotated trivially once ciphertext exists.
- **[security add-on]** Encrypt the secrets with a third CMK
  (`alias/aequilibri-secrets`).

Create one secret per logical credential (not one giant JSON blob — finer
audit + rotation), e.g.:

```
aequilibri/prod/DATABASE_URL            postgresql://aequilibri_app.<ref>:...@<pooler-host>:6543/postgres?pgbouncer=true&connection_limit=5
aequilibri/prod/CONTROL_DATABASE_URL    (same shape, control project's ref)
aequilibri/prod/DIRECT_URL              postgresql://postgres.<ref>:...@<pooler-host>:5432/postgres   (migrate task + ops ONLY)
aequilibri/prod/CONTROL_DIRECT_URL      (same shape, control project's ref)
aequilibri/prod/ANTHROPIC_API_KEY
aequilibri/prod/CLERK_SECRET_KEY  ·  CLERK_PUBLISHABLE_KEY
aequilibri/prod/PLATFORM_ENCRYPTION_KEY
aequilibri/prod/CRON_SECRET  ·  PLATFORM_WEBHOOK_SECRET  ·  OUTBOX_FEED_SECRET
aequilibri/prod/IMAP_*  ·  GOOGLE_*  ·  XERO_*  ·  GEOSCAPE_* (as needed)
```

Generate random secrets properly, e.g. `openssl rand -base64 48` (Git Bash)
— not by hand. Set a calendar-based **rotation schedule** (quarterly manual
rotation is a fine start; automated rotation Lambdas can come later).

**Who can read them:** only two IAM roles — the app task's *execution role*
(for injection at boot) and the migrate task's. Not the CI role, not
ReadOnly humans. That's expressed in the roles' IAM policies (Part 9) and,
**[security add-on]**, mirrored in the secrets' *resource policies* for
defence in depth.

---

## Part 8 — Front door: ACM + ALB + Route 53 (plan A7)

1. **Route 53 hosted zone** for the app domain (or subdomain) — if the domain
   is registered elsewhere, delegate the zone via NS records.
2. **ACM certificate** in ap-southeast-2 for the app hostname, DNS-validated
   (Terraform can create the validation records automatically since the zone
   is in Route 53). Auto-renews forever.
3. **ALB** in the two public subnets:
   - Listener 443 (the ACM cert) → forward to target group (IP type,
     port 3000, for Fargate).
   - Listener 80 → **redirect** to 443 (plan: HTTPS only).
   - **[security add-on]** TLS security policy: a TLS 1.3/1.2-only policy
     (e.g. `ELBSecurityPolicy-TLS13-1-2-2021-06`).
   - Target group health check: path `/api/health` (which B4 extends with
     DB probes), healthy threshold 2, interval 30s.
   - **[security add-on]** ALB access logs → an S3 logs bucket.
4. **[security add-on] AWS WAF** attached to the ALB with the managed rule
   sets: `AWSManagedRulesCommonRuleSet`, `KnownBadInputsRuleSet`,
   `AmazonIpReputationList`, plus a rate-limit rule (e.g. 2000 req/5min per
   IP). Cheap (~US$10–15/mo) and it's the standard answer to "what protects
   the public endpoint". Note: n8n Cloud and EventBridge must not be
   rate-limited into failure — start WAF in **count mode**, watch a week,
   then enforce.
5. Security groups (plan A7's exact rule): ALB SG allows 443/80 from the
   world; **app SG allows 3000 only from the ALB SG**; RDS SG allows 5432
   only from the app SG. Three links, each one narrow.
6. Route 53 `A`/`AAAA` **alias** records → the ALB.

---

## Part 9 — Compute: ECS cluster, task, service (plan A8)

### 9.1 IAM roles (the least-privilege core)
Four roles, each tiny:

| Role | Assumed by | Permissions |
|---|---|---|
| **Task execution role** | ECS agent (to boot the container) | Pull from the ECR repo; read the specific `aequilibri/prod/*` secrets; write the app's CloudWatch log group. Nothing else. |
| **App task role** | Your running app code | `s3:GetObject/PutObject/DeleteObject/ListBucket` on the documents bucket (+ its KMS key); nothing else. This is how the B1 S3 storer authenticates — no keys anywhere. |
| **Migrate task role** | The release migrate task | Same execution-role pattern but its secret set includes `ADMIN_DATABASE_URL`. |
| **CI role** (Part 12) | GitHub Actions via OIDC | Push to the ECR repo; register task definition; update the service; run the migrate task. No secret read access. |

### 9.2 Cluster + task definition
- Cluster with **Container Insights enabled** (metrics per task).
- App task definition: 1 vCPU / 2 GB, the ECR image, port 3000,
  `secrets:` entries mapping each env var to its Secrets Manager ARN,
  non-secret env (`NODE_ENV=production`, `DOCUMENTS_BUCKET=…`,
  `STORAGE_PROVIDER=s3`) as plain environment.
  **[security add-on]** `readonlyRootFilesystem = true` if the standalone
  build tolerates it (mount `/tmp` as a writable ephemeral volume), and the
  Dockerfile's non-root user (B2) declared via `user`.
- **Migrate task definition**: same image,
  `command: ["node", "scripts/migrate-all-tenants.mjs"]`, the admin DB URL.
- **Log configuration**: awslogs driver → log group
  `/ecs/aequilibri-app`, retention 90 days (set retention explicitly —
  default is "never expire" = cost + data-hoarding).

### 9.3 The service — and why it's shaped oddly
```
desired_count          = 1
deployment maximum_percent         = 100
deployment minimum_healthy_percent = 0
```
This means deploys **stop the old task, then start the new one** (~60–90 s
outage). It is deliberate: the codebase's scheduler lock, proposal claim
set, and per-process caches make two concurrent instances unsafe (the
hardening audit's single-instance pin). **Do not "fix" this by raising
desired_count** — that's only safe after a shared Redis exists.

- Attach the service to the target group; grace period ~60 s so the health
  check doesn't kill a booting task.
- **[security add-on]** `enable_execute_command = true` on the service —
  this is the SSM-based "shell into the container" path for emergencies:
  IAM-gated, fully session-logged, no SSH, no bastion.

**Exit criteria (plan Workstream A):** `terraform apply` from zero brings up
everything; the app task boots against empty databases; `https://<domain>/api/health`
returns OK through the ALB.

---

## Part 10 — The scheduler: EventBridge (plan A9)

The app's cron is an HTTP endpoint (`/api/platform/scheduler`) guarded by
`CRON_SECRET` — no in-cluster cron.

1. EventBridge Scheduler schedule, `rate(1 hour)`, timezone irrelevant
   (hourly), **flexible window OFF**.
2. Target: *API destination* → `https://<domain>/api/platform/scheduler`,
   with a connection whose auth header is
   `Authorization: Bearer <CRON_SECRET>` (the connection stores the secret
   in Secrets Manager under the hood — point it at the existing one).
3. Retry policy: 2 retries, max age ~10 min (a missed hour is tolerable; a
   double-fire is idempotent-guarded by the app's scheduler lock, but don't
   pile up stale retries).
4. Alarm on failed invocations (Part 14).

---

## Part 11 — Codebase items before first deploy (plan Workstream B)

These are repo changes, not infrastructure (details in the plan; listed here
for ordering):

1. **B1 — S3 document storer** in `src/lib/platform/storage.ts`: third
   provider `s3` using `@aws-sdk/client-s3`, bucket from `DOCUMENTS_BUCKET`,
   **task-role auth — the constructor takes no credentials at all**; the SDK
   finds the task role automatically. Plus the one-shot
   `scripts/migrate-local-storage-to-s3.mjs`.
2. **B2 — Dockerfile**, multi-stage: deps → `npm run db:generate` + build
   with `output: "standalone"` (add to next.config; keep the
   `serverExternalPackages` natives — copy `@napi-rs/canvas`/`geotiff` into
   the runtime layer) → `node:24-slim`, **non-root user**, port 3000, plus
   `.dockerignore` (must exclude `.env*`, `var/`, `.git`).
3. **B3 — Migrate entrypoint**: the same image runs
   `node scripts/migrate-all-tenants.mjs` (already fail-fast + re-pins RLS).
4. **B4 — Health endpoint**: extend `/api/health` with cheap `SELECT 1`
   probes on control + default tenant, so the ALB health check actually
   proves DB connectivity.
5. **B6 — delete `render.yaml`** once ECS is proven.

Test locally before any AWS deploy:
```
docker build -t aequilibri-app .
docker run --rm -p 3000:3000 --env-file .env.docker aequilibri-app
```
(`.env.docker` = local-cluster URLs; never commit it.)

---

## Part 12 — CI/CD: GitHub Actions with OIDC (plan B5)

The enterprise point here: **GitHub never holds AWS keys.** OIDC federation
means GitHub proves "I am a workflow on repo X, branch main" and AWS hands
it short-lived credentials for one narrow role.

1. Create the GitHub repo (open decision 2) and push this working copy —
   **first push ever for this code**; verify no `.env` files are tracked
   before pushing (`git ls-files | grep -i env`).
2. Terraform: `aws_iam_openid_connect_provider` for
   `token.actions.githubusercontent.com`, and the **CI role** whose trust
   policy pins `repo:<org>/<repo>:ref:refs/heads/main` (branch-pinned —
   a PR from a fork can never assume it).
3. Workflow on push to main:
   1. typecheck + vitest;
   2. build image, tag with the git SHA;
   3. push to ECR;
   4. **run the migrate task and wait for exit 0**
      (`aws ecs run-task` + `aws ecs wait tasks-stopped` + check exit code —
      a failed migration must abort the deploy);
   5. `aws ecs update-service --force-new-deployment` with the new task
      definition revision.
4. **[security add-on]** GitHub repo settings: branch protection on `main`
   (PRs + required checks), secret-scanning + push protection enabled.

---

## Part 13 — Data migration and cutover (plan Workstream C)

Sequence (each step gated on the previous):

1. **C1 — provision prod databases** *(amended for Supabase)*: core projects
   exist from Part 4; from the ops runbook (never the app role), run
   `provision-tenant-db.mjs --slug meridian-legal` and `--slug
   dulong-downs-didi` (Management API → per-client projects); then
   `seed-control-plane.mjs`. Existing tenant data moves by
   `pg_dump -Fc --no-owner --no-acl` from the current server →
   `pg_restore` into the project over the session pooler → re-run grants +
   RLS pin → verify counts → `--activate` writes the pooled + direct URLs
   into the registry. (`pg_dump` client version ≥ Supabase's PG major.)
2. **C2 — full data move**: mover with `--target-url` (the session URL)
   against prod Supabase, attachments script with `--apply-refs` (binaries
   land in the attachments bucket), then produce **verification report v2**
   in the same format as `docs/migration-verification-2026-07-29.md`.
3. **Soak** on the staging/prod stack while Airtable remains source of truth.
4. **C5 before C3** — the client conversation: Didi loses direct Airtable
   base access; agree what replaces it (portal/exports). This is a blocker
   for cutover, not a nice-to-have.
5. **C3 — cutover** (scheduled window, half a day):
   freeze Airtable writes (client comms!) → final incremental mover run
   (idempotent on `airtableRecordId`) → verify counts → DNS switch (Route 53
   alias flip) → Airtable read-only for the agreed retention window → final
   export to the backups bucket → close workspace.
6. **C4 — post-cutover**: revoke the Airtable PAT the same day;
   `pg-to-airtable.mjs` fate = owner's pending decision 3.

---

## Part 14 — Backups, monitoring, ops (plan §7)

### Backups — two layers, both required
1. **Supabase daily backups** (7-day retention on Pro, per project) —
   project-level disaster recovery. PITR is a per-project paid add-on;
   enable per client on request. *(amended 2026-08-13; was RDS PITR)*
2. **Weekly logical `pg_dump` of EVERY database** (control + each tenant,
   over the session pooler using the registry's `tenantDirectUrl`s) to the
   backups bucket, via a scheduled ECS task (same image or a tiny
   postgres-client image; EventBridge weekly trigger). These per-database
   dumps are the **per-tenant offboarding/restore artifact §2b promises** —
   and with per-project Supabase backups they double as the only aggregated,
   self-held copy.
3. **Test a restore before go-live** — restore one tenant dump into a scratch
   database and run the app against it. An untested backup is a hope, not a
   backup. **[security add-on]** Put a quarterly restore-test reminder in the
   ops calendar.

### CloudWatch alarms (each → an SNS topic → email, later Slack)
- ECS: running task count < 1 for 5 min (crash-loop).
- ALB: 5xx count and unhealthy-host count.
- Database *(amended)*: Supabase dashboard per-project alerts (disk, CPU,
  connections); no RDS CloudWatch metrics exist.
- EventBridge scheduler: failed invocations > 0.
- **[security add-on]** GuardDuty findings ≥ MEDIUM → same SNS topic.
- **[security add-on]** Billing anomaly detection (Cost Anomaly Detection,
  one-click).

### Standing ops rules
- Secrets rotation schedule (quarterly; Anthropic/Clerk keys on provider
  rotation, DB passwords via Secrets Manager).
- Deploys are a ~60–90 s blip (single task, stop-then-start) — deploy in AU
  off-hours; revisit only with Redis + 2 tasks.
- Human DB/container access only via ECS Exec (SSM-logged), never standing
  credentials.

---

## Part 15 — Go-live security checklist

Run through this the week before cutover; every box must be checked.

**Identity & account**
- [ ] Root: MFA (×2 devices), zero access keys, unused since setup
- [ ] All humans via Identity Center + MFA; **zero classic IAM users**
- [ ] CI: OIDC only, role trust pinned to repo+branch; no AWS keys in GitHub
- [ ] CloudTrail (all regions, validated), Config, GuardDuty, Security Hub on; Security Hub CRITICAL/HIGH findings triaged

**Network**
- [ ] ECS in private subnets; SG chain exactly: world→ALB(443) → ALB→app(3000); default SG empty
- [ ] *(amended)* Supabase network restrictions pinned to the NAT EIP (optional but recommended)
- [ ] VPC endpoints for S3/ECR/Secrets/Logs; VPC Flow Logs on

**Data**
- [ ] *(amended)* All Supabase projects in ap-southeast-2; daily backups on (Pro); no `db.<ref>` direct-host URLs stored anywhere
- [ ] App connects as `aequilibri_app` over the transaction pooler (`?pgbouncer=true` present) — verified **no** SUPERUSER/BYPASSRLS/CREATEDB (`SELECT rolname, rolsuper, rolbypassrls, rolcreatedb FROM pg_roles;`) — this is what makes tenant RLS real
- [ ] All S3 buckets: public access blocked (account + bucket), CMK encryption, TLS-only policy; documents bucket versioned + access-logged
- [ ] Weekly per-database dumps running; **one restore actually tested**

**Secrets**
- [ ] Every prod secret freshly generated; nothing from repo history
- [ ] `PLATFORM_ENCRYPTION_KEY` set before any Xero/Drive connection stored
- [ ] Only task execution/migrate roles can read secrets; rotation schedule in calendar
- [ ] Airtable PAT revoked at C4

**Edge & app**
- [ ] HTTPS only (80→443 redirect), TLS 1.2+ policy, ACM auto-renew verified
- [ ] WAF attached (managed rules + rate limit), switched from count → block after observation
- [ ] Container: non-root, image tag immutable, scan-on-push clean of criticals
- [ ] `/api/health` probes both DBs; alarms wired to a monitored address

---

## Suggested order of execution (maps to plan §9)

| Step | Parts here | Plan ref | Est. |
|---|---|---|---|
| 1. Account + security baseline + tooling | 1–2 | A1 | ½–1 day |
| 2. Network, RDS, S3, ECR, Secrets, ALB | 3–8 | A2–A7 | 2–3 days |
| 3. Code items (parallel with 2) | 11 | B1–B4 | 2–3 days |
| 4. ECS + scheduler + CI/CD into staging | 9, 10, 12 | A8–A9, B5 | 1–2 days |
| 5. Prod data + verification | 13 (C1–C2) | C1–C2 | 1–2 days |
| 6. Soak + client conversation | 13 (C5) | C5 | owner-paced |
| 7. Cutover + post-cutover | 13 (C3–C4), 15 | C3–C4 | ½ day window |

≈ 1.5–2 engineering weeks of hands-on work, plus owner/client dependencies —
matching the plan's estimate; the security add-ons above add hours, not days.
