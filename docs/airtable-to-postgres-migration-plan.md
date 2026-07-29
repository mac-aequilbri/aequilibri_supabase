# Airtable → Postgres Full-Migration Implementation Plan

**Status:** PLAN ONLY — nothing in this document has been executed.
**Written:** 2026-07-29.
**Intended use:** hand this file to a fresh Claude Code session running against a **copy** of the `aequilibri-next` codebase. That session will have none of the original project's memory or conversation history — this document is self-contained on purpose. Read it fully before writing code.

---

## 1. Context and goal

- **Driver: compliance.** The client requires all data to reside in Australia. Airtable's AU data residency (Enterprise Scale plan) was offered as an alternative; the decision here assumes we proceed with a **full exit from Airtable to Postgres** hosted in an Australian region.
- **Consequence of the compliance driver:** the existing per-org `data_backend_postgres` feature flag is NOT sufficient. Compliance requires *all* data out of Airtable: tenant/domain data, the platform **control plane** (org registry, team, RLS assignments, outbox, catalogs), chat/audit history, and attachment binaries.
- **Workspace strategy (owner decision):** work happens on a **copy of the codebase**, not on the original repo. The original stays live on Airtable; the copy becomes the Postgres-native build. Do not push changes back to the original repo/remote unless the owner says so.
- **Hosting note (ops, mostly out of code scope):** the current deploy target is Render, which has **no Australian region** (as of July 2026: Oregon, Virginia, Ohio, Frankfurt, Singapore; Sydney signalled but unreleased). The production Postgres must live in an AU region (AWS/Azure/GCP Sydney, Supabase/Neon ap-southeast-2, etc.). Plan Phase 7 covers this at the checklist level.

## 2. Current state (verified 2026-07-28/29 in the source repo)

A backend-switch audit ran 2026-07-28 (report: `docs/airtable-postgres-switch-audit.md` — read it) and four remediation phases (A–D) were built and pushed to master the same day (commit `d5befeb`, 74 files). What exists:

### Already built
- **Backend flag:** `airtableEnabled(ctx?)` in `src/lib/airtable/config.ts`. Global lever = `AIRTABLE_MIGRATION` env boolean; per-org override = `data_backend_postgres` feature in the org registry's Settings JSON (opt-OUT to Postgres). Branched inline at ~180 call sites across ~70 files; ~150 sites receive `ctx`, ~28 are deliberately global (health, org-context, schema-drift, uc1Source, onboarding).
- **ID bridge:** `airtableRecordId String? @unique` on all 37 `Plat*` Prisma models. This is the idempotency key for data movement.
- **Schema parity:** 11 models added 2026-07-28 — `PlatComms`, `PlatConPlanTask`, `PlatEngagementTypeConfig`, and 8 `PlatCtl*` control-base mirrors — plus 5 spec-12 lock columns. Migration SQL: `prisma/migrations/20260728000000_phase_b_airtable_bridge/migration.sql`. **This migration was generated via datamodel diff but has NEVER been applied to any database** (there was no local PG at build time).
- **Data movers:** `scripts/migration/{_shared,_map,airtable-to-pg,pg-to-airtable}.mjs`. 23 tables in topological order, hand-derived from `src/lib/airtable/fieldMaps.ts` (**keep `_map.mjs` in sync with fieldMaps.ts if either changes**). Idempotent via `airtableRecordId`; dry-run by default; checkpoints written to `var/migration/`. **Never run against a live Postgres.**
- **PG delegates:** COMMS and PLAN now have Prisma delegates (`PlatComms`, `PlatConPlanTask`) wired through `src/lib/platform/recordWriter.ts`. Diagnostics page shows per-org backend and asymmetry lists.
- **Boot guard:** `src/instrumentation.ts` (`NEXT_RUNTIME=nodejs`) warns at boot about backend asymmetries (COMMS/PLAN/CASHFLOWS unavailability in PG mode; missing PAT/control-base/DATABASE_URL in Airtable mode).

### Known gaps (this plan's work)
1. **CASHFLOWS has no PG delegate — it throws in Postgres mode.** The legacy `PlatConCashflow` model is a monthly shape that does not match the Spec-12 cashflow ledger. Needs a new ledger model, delegate, and migration-map entry. Biggest net-new engineering item.
2. **Control plane runtime is Airtable-only.** The `PlatCtl*` mirror models exist in Prisma but nothing reads/writes them. Org registry, team, RLS assignments (`PLAT_ASSIGNMENTS`), outbox, job catalog (`PLAT_JOB_CATALOG`), and cascades all hit the Airtable control base at runtime.
3. **Data excluded from mover v1:** CASHFLOWS, HYPOTHESES/CORRECTIONS, chat/audit history, TEAM/control tables.
4. **Attachment binaries:** `scripts` exporter (`airtable-export-backup.mjs`) does not download attachment files — only URLs, which Airtable expires.
5. **recordWriter failure-audit path writes Postgres unconditionally** even in Airtable mode (harmless here — in a PG-only build it's fine, but be aware when reading the code).
6. **Prisma drift decisions from Phase B:** VARIATIONS superseded by CHANGE_LOG (CHANGE_LOG unmodelled), DOMAIN_LABELS/REGIONS unmodelled. Revisit whether these need models in a PG-only world.
7. **Recent Airtable-coupled features:** email-intelligence pipeline (`src/services/platform/emailIntel.ts`), n8n outbound events (carry Airtable org/record ids), inbound webhook flow. Built July 2026, never verified in PG mode.

### Live tenants in the source system (for the data-migration phase)
- **Dulong Downs Didi** — first real-data client, construction vertical, base `appmDPKjRT4Kp9rvN`. **Has real field drift** vs the template (PHASES/RISKS/etc.) — the mover map may not match its base 1:1; reconcile before/while exporting.
- **Meridian Legal Group** — legal vertical demo, base `appr9sReyIHgS6FXy`, ~3000 synthetic matters (useful as migration volume test).
- **Control base** — `PLAT_*` tables (org registry, team, assignments, outbox, catalogs, cascades). Env var `AIRTABLE_CONTROL_BASE_ID`.

---

## 2b. Tenancy architecture (owner decision): database per client

> Owner-supplied section (2026-07-29; replaces an interim draft by the
> executing session). The 8 design rules are constraints, not suggestions,
> from Phase 2 onward.

**Airtable→Postgres topology mapping.** The Postgres deployment mirrors the
Airtable topology rather than flattening it:

| Airtable (today) | Postgres (target) |
|---|---|
| Control base (`PLAT_*` tables) | **Control DB** (org registry, team, assignments, outbox, catalogs, cascades) |
| One base per client org | **One tenant DB per org** |
| Template-base cloning at onboarding | `CREATE DATABASE` + `migrate deploy` + seed |

**Design rules (all 8 mandatory):**

1. **Split the Prisma clients along the existing `db.ts` guard-regex line.**
   `db.ts` already partitions the model namespace with
   `/^Plat(?!Organisation$|Ctl)/` — models matching it are tenant-scoped;
   `PlatOrganisation` and `PlatCtl*` are control-plane. That line becomes the
   physical split: control schema → control DB, tenant schema → tenant DBs.
2. **Build the `db(ctx)` resolver on the Phase D ctx threading.** ~150 call
   sites already receive an `OrgCtx`; the tenant-client resolver keys off that
   same ctx (org → cached PrismaClient) instead of introducing a new
   parameter-passing scheme.
3. **Keep `orgId` columns as a tripwire.** Tenant tables keep `orgId` and the
   org-isolation guard stays active even though each tenant DB holds one org —
   wrong-DB wiring bugs must hit a second, independent wall. Existing
   isolation regression tests keep passing unchanged.
4. **Enable native Postgres RLS inside each tenant DB** as hard enforcement
   beneath the application guard.
5. **Fix `airtableRecordId` uniqueness to `(orgId, airtableRecordId)`.** The
   Phase B bridge made it globally `@unique` per table; Airtable rec-ids are
   only meaningful per base, and shared staging/dev DBs hold multiple orgs.
   Composite uniqueness from here on (new models get it from day one).
6. **Build the migrate-fan-out script.** Schema changes apply to every tenant
   DB + control DB in one operation; a tenant DB with divergent schema is a
   defect. (Airtable's per-base field drift does NOT get re-created in PG.)
7. **Accept that cross-tenant SQL is impossible.** Any feature that would
   join/aggregate across orgs in one query must be redesigned as per-tenant
   queries composed in application code (platform-admin views, diagnostics,
   movers, reconciliation, backups iterate orgs via the control DB registry).
8. **Plan for pool growth.** Each active tenant DB carries its own connection
   pool; cap pool size per tenant, bound/dispose cached clients, and budget
   connections as tenant count grows.

**Client-facing consequence to raise before cutover:** Didi currently has
direct access to their Airtable base; after migration there is no equivalent
"open the database" surface. That conversation (what replaces direct base
access — portal, exports, read-only reporting) must happen with the client
before cutover, not after.

---

## 3. Ground rules for the executing session

- Work only in the codebase **copy**. Never write to the original repo's remote.
- This is a **one-way** migration build: the target end-state has no Airtable runtime dependency. `pg-to-airtable.mjs` and Airtable provisioning code may be kept for reference/rollback during transition but are not part of the end-state.
- The Airtable side stays read-only during migration development. Do not write to live Airtable bases from the copy. Consider a **read-only scoped PAT** for the copy's `.env`.
- After each phase: `npx tsc --noEmit`, run vitest, and boot the dev server in PG mode. Three vitest file-failures are **pre-existing** (DB-dependent suites that need a local PG — they should start passing once Phase 0 provides one; if they don't, investigate rather than skip).
- Commit per phase with clear messages. The copy is a long-lived divergence; keep its history readable.

---

## Phase 0 — Workspace + local Postgres bring-up (≈ half a day)

1. Copy the codebase to a new directory (e.g. `aequilibri-pg`). Keep `.git` but add a new remote (or re-init) per owner preference; **remove/replace the `origin` remote so nothing pushes to the live repo's GitHub (Render auto-deploys from it).** Also check `render.yaml` — the copy must not be wired to the live Render service.
2. Fresh `.env`: new `DATABASE_URL` (local PG), read-only Airtable PAT, `AIRTABLE_MIGRATION` **unset/false** (Postgres mode), keep Clerk dev keys.
3. Stand up local Postgres (Docker: `postgres:16`).
4. Apply migrations: `npx prisma migrate deploy` (applies everything through `20260728000000_phase_b_airtable_bridge` for the first time — expect and fix any diff-vs-reality issues here; the SQL was machine-generated and never executed).
5. `npx prisma generate`. **Windows gotcha:** the query-engine DLL locks while the dev server runs — stop the dev server first.
6. Regenerate the Airtable schema snapshot if needed: `scripts/airtable-gen-schema.mjs` (the checked-in `schema.generated.ts` was stale as of 2026-07-28 — missing QUOTES.Assessment).
7. Boot dev server in PG mode; capture the `[backend-guard]` boot warnings as the initial gap list. **Dev-server gotcha:** Next 16 allows one dev server per project; a wedged server 404s every `/app` route — restart fixes it. The in-app Browser pane may not show streamed content on initial load; verify via client-side navigations.

**Exit criteria:** migrations applied cleanly, prisma client generated, app boots in PG mode, gap list recorded.

## Phase 1 — Make Postgres mode fully bootable (≈ 1–2 days)

1. Walk every route/window in PG mode with an empty database. Expected hard failure: cashflow (Phase 2). *(Correction 2026-07-29, Phase 1 execution: the cashflow window loads fine on an empty DB — only cashflow **writes** throw, per the boot guard. No route hard-fails on GET.)* Everything touching the control plane will still silently hit Airtable — that's Phase 3; just inventory those touchpoints now. *(Correction: with `AIRTABLE_MIGRATION=false`, `controlEnabled()` is also false, so control-plane sites no-op/fallback rather than hitting Airtable.)*
2. Fix any PG-mode crashes that aren't cashflow/control-plane (there will be some — PG mode has barely been exercised).
3. Decide `uc1Source` and onboarding globals: in a PG-only build the ~28 deliberately-global `airtableEnabled()` sites should mostly resolve to hard-coded PG paths. Inventory them (grep `airtableEnabled(` with no ctx arg) and convert where safe.
4. Get vitest green, including the 3 DB-dependent suites now that a local PG exists.

**Exit criteria:** every window loads (or degrades gracefully) in PG mode except cashflow; test suite green.

## Phase 2 — Cashflow ledger model (≈ 3–5 days; the long pole)

1. Read the Spec-12 cashflow requirements (see `docs/` — MASTER_IMPLEMENTATION_GUIDE.md is the consolidated reference; some older docs moved to `docs/archive/`). The Airtable CASHFLOWS table is the current source of truth for shape — read its field map in `fieldMaps.ts`.
2. Design a `PlatConCashflowLedger` (name per repo conventions) Prisma model matching the Spec-12 ledger shape, with `airtableRecordId` bridge column. Decide the fate of legacy `PlatConCashflow` (likely: keep for history, don't wire).
3. Prisma migration + client regen.
4. Wire the delegate in `src/lib/platform/recordWriter.ts` following the exact pattern used for `PlatComms`/`PlatConPlanTask` (Phase D pattern — read those diffs, commit `d5befeb`).
5. Wire cashflow **reads** (list window, detail, chart aggregation). Cross-check the cashflow chart math — a 2026-07-20 UI audit flagged it as one of 4 Criticals.
6. Add CASHFLOWS to `scripts/migration/_map.mjs` with an Airtable→ledger field transform.
7. Remove the CASHFLOWS throw from PG mode and the boot-guard asymmetry entry.

**Exit criteria:** cashflow window fully functional in PG mode with seeded data; mover map covers it.

## Phase 3 — Control plane to Postgres (≈ 1–2 weeks)

The 8 `PlatCtl*` mirror models exist but nothing uses them. This phase makes the runtime read/write Postgres for:

1. **Org registry** (org list, settings JSON incl. feature flags, base ids). Note: `db.ts` has a guard regex `/^Plat(?!Organisation$|Ctl)/` — understand it before touching.
2. **Team / membership.**
3. **RLS assignments** (`PLAT_ASSIGNMENTS` central store — project-level RBAC is feature-complete and enforced across read/write/aggregate/AI seams; do not regress it. Regression tests exist, commit `5fc63f3`).
4. **Outbox / outbound events** (feeds n8n; events currently carry Airtable record ids — decide the PG-native id story here).
5. **Catalogs**: `PLAT_JOB_CATALOG` (per-vertical job categories, data-driven since July), engagement-type config, cascades (CASCADE-A..G advisory records seeded on live orgs).
6. Approach: introduce a thin control-plane repository layer rather than branching inline at each call site (the audit's main structural criticism was 180 inline branches — don't repeat it for the control plane).
7. Seed script for a fresh PG control plane (orgs, team, catalogs) so dev/staging can boot without any Airtable export.
8. *(Added 2026-07-29, found in Phase 2)* **Un-gate the cascade engine in PG mode.** `runCascades()` returns immediately unless `airtableEnabled(ctx)` — no cascade write-effects (D: procurement→cashflow, F: blocker→phase RAG, G: risk→issue) or advisories fire in PG mode. The rules' `execute` functions and `recordAdvisory`/`markRuleApplied` are `core.*`-coupled and gate on `rec…` ids throughout. PG models exist for everything they touch (learning rules, EXECUTION_LOG, ledger, phases, issues), so this is a port, not a redesign — but it must come before cutover or standing automation silently disappears.

**Exit criteria:** app boots and operates with `AIRTABLE_CONTROL_BASE_ID` unset; boot guard no longer references the control base.

## Phase 4 — Excluded data + attachments (≈ 3–5 days)

Extend the movers for everything mover-v1 excluded:

1. **CASHFLOWS** — done in Phase 2's map entry; verify here.
2. **HYPOTHESES / CORRECTIONS** (learning module) — add to `_map.mjs`.
3. **Chat / audit history** — decide with owner: migrate, or archive-and-start-fresh (chat channels are session-title-based; audit may be compliance-relevant, so lean migrate).
4. **TEAM / control tables** — mover for the control base into the `PlatCtl*` models (pairs with Phase 3).
5. **Attachments:** extend the export to download attachment binaries (Airtable attachment URLs expire — download during export, not later) into AU-resident object storage (e.g. S3 ap-southeast-2), and add an attachment reference model/columns on the PG side.
6. **CHANGE_LOG / DOMAIN_LABELS / REGIONS:** decide model-or-drop (unmodelled as of Phase B).

**Exit criteria:** `_map.mjs` covers every table that must survive; attachment pipeline tested against one real base.

## Phase 5 — Data migration execution + validation (≈ 3–5 days)

1. Dry-run `airtable-to-pg.mjs` against **Meridian Legal** (synthetic, ~3000 matters — safe volume test). Fix mapper fallout.
2. Live-run into local/staging PG. Validate with `src/lib/platform/reconciliation.ts` (field-diff machinery) + row counts per table.
3. Repeat for **Didi** — expect field drift (PHASES/RISKS/etc. diverge from template). Reconcile drift in the map; do NOT run `migrateBaseToTemplate` against their live base from the copy (it mutates Airtable; and note its gotcha: it copies from the live TEMPLATE base, not `schema.generated`).
4. Migrate the control base (Phase 4.4 mover).
5. Rate limits: reads go through the TTL-cache/limiter layer (`2dce812`); the mover uncaps pagination (`maxRecords ≥ 100` fetches all pages — counts are accurate). Long runs are checkpointed in `var/migration/` and resumable.
6. Write a **verification report** per org: table-by-table counts, reconciliation diffs, attachment tally, spot-checked records.

**Exit criteria:** both orgs + control plane fully materialised in PG; reconciliation clean; report saved to `docs/`.

## Phase 6 — Decommission Airtable in the codebase (≈ 3–5 days)

1. Delete or quarantine (`src/lib/airtable/` → keep only what the movers need, movable to `scripts/`): provisioning (`provision.ts`), write paths, snapshot/nav-badge Airtable reads, schema-drift checks, Airtable diagnostics sections.
2. Simplify `airtableEnabled()` to constant-false, then mechanically remove dead branches (this is ~180 sites — do it with grep discipline, `tsc` after each batch; don't leave a permanently-false flag).
3. **n8n / email intelligence:** rework inbound email flow and outbound events to PG ids. Gotchas from the live integration: HMAC is computed over `\uXXXX`-escaped ASCII rawBody (non-ASCII broke signing — preserve this convention); n8n Cloud uses `$vars` not `$env`, the Crypto node not `require('crypto')`; a 401 does NOT fail the n8n run (neverError). n8n workflows live in `n8n/`.
4. Onboarding: replace the create-Airtable-base / supply-existing-base-id flows with PG-native org provisioning (Phase 3's seed machinery).
5. Update `docs/` and env-var docs; remove `AIRTABLE_*` from `render.yaml`/blueprint for the new deployment.

**Exit criteria:** `grep -ri airtable src/` returns only intentional remnants (movers/archive); app fully functional with no Airtable env vars set; tests green.

## Phase 7 — AU infrastructure + cutover (ops checklist, coordinate with owner)

1. Provision production Postgres in an Australian region (Render has NO AU region as of July 2026 — use AWS/Azure/GCP Sydney or Supabase/Neon ap-southeast-2). App compute location per client's at-rest-vs-processing answer (unresolved owner question — confirm before committing infra).
2. **Scheduled backups** — already a Critical in the 2026-07-26 enterprise audit; non-negotiable before go-live. Include attachment storage.
3. Secrets: fresh secrets for the new deployment (the hardening audit required rotation anyway); production Clerk instance decision (shared vs new).
4. n8n Cloud instance region review (currently EU-hosted) against the client's processing requirements; same for Anthropic API usage and Clerk.
5. Cutover: freeze Airtable writes → final incremental mover run (idempotent via `airtableRecordId`) → verify → DNS/traffic switch → keep Airtable read-only for an agreed retention window → export final backup → close Airtable workspace.
6. Do not scale above 1 instance (no multi-instance guard — hardening audit).

---

## Rough total: 4–6 weeks engineering (Phases 0–6) + ops cutover.

## Open decisions for the owner (ask before the relevant phase)
1. Chat/audit history: migrate or archive? (Phase 4)
2. CHANGE_LOG / DOMAIN_LABELS / REGIONS: model or drop? (Phase 4)
3. Keep `pg-to-airtable.mjs` rollback capability through cutover, or delete in Phase 6?
4. At-rest-only vs processing residency — determines app-compute location and whether Clerk/Anthropic/n8n need replacing. (Phase 7, but affects scope)
5. New repo/remote name + Render-vs-AU-host for app compute.

## Key file inventory
| Concern | Path |
|---|---|
| Backend flag | `src/lib/airtable/config.ts` (`airtableEnabled`) |
| Write engine + delegates | `src/lib/platform/recordWriter.ts` |
| Field maps (source of truth for mover map) | `src/lib/airtable/fieldMaps.ts` |
| Movers | `scripts/migration/{_shared,_map,airtable-to-pg,pg-to-airtable}.mjs` |
| Unapplied bridge migration | `prisma/migrations/20260728000000_phase_b_airtable_bridge/migration.sql` |
| Boot asymmetry guard | `src/instrumentation.ts` |
| Reconciliation / field diff | `src/lib/platform/reconciliation.ts` |
| Airtable provisioning (to retire) | `src/lib/airtable/provision.ts` |
| Audit report (background) | `docs/airtable-postgres-switch-audit.md` |
| Original 23-table mapping doc | `docs/archive/airtable-migration-mapping.md` (§7.1 = ID-bridge design) |
| n8n workflows + webhook tooling | `n8n/` |
| Email intelligence | `src/services/platform/emailIntel.ts` |
