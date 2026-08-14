# aequilibri-next

Multi-tenant AI-assisted operations platform for project-based businesses (construction, roofing, legal verticals). Next.js 16 App Router + TypeScript, **Postgres as the system of record** via Prisma — a control-plane database plus **one database per client org** (§2b; in production, one **Supabase** project per database, Sydney region), Clerk authentication, Anthropic-powered assistant/agents (in-app + MCP). Deploy target: **AWS ECS Fargate ap-southeast-2 + Supabase** ([docs/aws-deployment-plan.md](docs/aws-deployment-plan.md)).

## Architecture in one paragraph

UI (server components, `src/components`) → server actions / API routes (`src/app`) → domain services → [src/lib/db.ts](src/lib/db.ts), the single DB seam: a control Prisma client (`CONTROL_DATABASE_URL` — org registry, team, assignments, outbox, catalogs) and per-tenant Prisma clients resolved by `db(ctx)` from the registry's `settings.tenantDatabaseUrl` (LRU-cached, org-isolation guard, native RLS org-pin inside each tenant DB). Airtable was decommissioned in migration Phase 6. Full details: [MASTER_IMPLEMENTATION_GUIDE.md](MASTER_IMPLEMENTATION_GUIDE.md).

## Local development

```bash
npm ci
npm run dev        # http://localhost:3000
```

Local dev runs against a local Postgres cluster: `DATABASE_URL` (default tenant DB) + `CONTROL_DATABASE_URL` (control DB), with `DIRECT_URL`/`CONTROL_DIRECT_URL` mirroring them (the Prisma CLI migrates via `directUrl`; only production has a pooler). `npm run db:generate && npm run db:migrate` to set up. Without auth/AI secrets the app runs in **demo mode**; Clerk key pair activates auth (fails closed in production without them), `ANTHROPIC_API_KEY` activates live AI. Production URLs are Supabase Supavisor pairs — transaction pooler (`?pgbouncer=true`) at runtime, session pooler for migrations/ops; per-client projects are provisioned by `scripts/provision-tenant-db.mjs` (Supabase Management API).

```bash
npm run typecheck && npm run lint && npm test   # the CI gate, locally
```

## Deployment

Target: push to `main` → [deploy.yml](.github/workflows/deploy.yml) (test job with a Postgres 16 service; deploy job gated on repo variables) → ECR → one-off ECS migrate task (`scripts/migrate-all-tenants.mjs`) → ECS service redeploy (single instance — **do not scale >1** until a shared Redis exists). Database tier: Supabase (Sydney), one project per database — see [docs/aws-deployment-plan.md](docs/aws-deployment-plan.md) (amended 2026-08-13) and [docs/aws-deployment-guide.md](docs/aws-deployment-guide.md). Health: `GET /api/health` (probes control + default tenant DBs). Hourly automation via [scheduler.yml](.github/workflows/scheduler.yml).

## Operations

- **Consolidated implementation reference:** [MASTER_IMPLEMENTATION_GUIDE.md](MASTER_IMPLEMENTATION_GUIDE.md) (architecture, configuration, ops, ADRs; historical docs live in `docs/archive/`)
- **Runbook, incident response, rollback, DR:** [docs/production-readiness-audit.md](docs/production-readiness-audit.md) (Operations artifacts section)
- **Enterprise audit + action register:** [docs/enterprise-audit-2026-07-26.md](docs/enterprise-audit-2026-07-26.md)
- **Client onboarding:** [docs/module1-onboarding-runbook.md](docs/module1-onboarding-runbook.md)
- **Design system / UI conventions:** [docs/design-system.md](docs/design-system.md)
- Operational scripts live in `scripts/` (Airtable schema/seeding, `airtable-export-backup.mjs`, guarded `reset-platform-orgs.mjs`)

## Repo map

| Path | What |
|---|---|
| `src/app/(platform)` | Multi-tenant platform (`/app/[org]/…` — dashboards, approvals, cashflow, reports, assistant) |
| `src/app/(uc1)` | Legacy roofing app (auth-gated with the platform) |
| `src/app/(public)` | Landing + client portal (`/portal/[token]`) |
| `src/lib/airtable` | Airtable client, rate limiter, caches, control-base registry |
| `src/lib/platform` | Auth/org context, RLS, recordWriter, sources, crypto, logger |
| `src/services` | Domain services (assistant/agents, documents, scheduler, construction) |
| `docs/` | Architecture, audits, plans, runbooks |
