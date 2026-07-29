# Airtable → Postgres migration — running progress log

Companion to `docs/airtable-to-postgres-migration-plan.md`. One section per phase:
what was done, deviations from the plan and why, and plan errata.

---

## Phase 0 — Workspace + local Postgres bring-up (2026-07-29)

### Done
1. **Live-repo safety (rule of engagement #3):** `origin` pointed at
   `https://github.com/mac-aequilbri/aequilibri_didi.git` — the live repo Render
   auto-deploys from. **Removed the remote** (recorded here so it can be re-added
   deliberately if ever needed). No new remote added yet — repo/remote name is
   owner open-decision #5. `render.yaml` itself still describes the live
   `aequilibri-next` service, but blueprint deploys are only triggered via the
   GitHub↔Render link, which is now severed; render.yaml gets reworked in
   Phase 6.5/7 anyway.
2. **Local Postgres 16.12** stood up. Deviation: no Docker/WSL/psql on this
   machine and no admin rights assumed, so instead of the plan's `postgres:16`
   container the official EDB **portable binaries** were installed user-level:
   - binaries: `%LOCALAPPDATA%\aequilibri-pg\pgsql`
   - data dir: `%LOCALAPPDATA%\aequilibri-pg\data16`, log `%LOCALAPPDATA%\aequilibri-pg\pg.log`
   - start: `pg_ctl -D %LOCALAPPDATA%\aequilibri-pg\data16 -l %LOCALAPPDATA%\aequilibri-pg\pg.log start`
   - superuser `aequilibri` / `aequilibri`, port 5432, db `aequilibri`
3. **.env updated** (not rebuilt from scratch — it already matched the plan's
   target): real local `DATABASE_URL`, `AIRTABLE_MIGRATION=false` (PG mode),
   PAT kept and annotated READ-ONLY (owner: consider re-scoping it), Clerk dev
   keys kept.
4. **Migrations applied** — all 7 historical migrations applied cleanly to the
   fresh DB, including the never-executed `20260728000000_phase_b_airtable_bridge`.
5. **Drift found and fixed** (plan predicted "diff-vs-reality issues"):
   `plat_con_accountingconnection.access_token` was `VARCHAR(500)` in the
   baseline migration but `@db.Text` in `schema.prisma` (schema edited without a
   migration, presumably for encrypted OAuth tokens). New migration
   `20260729000000_access_token_text` aligns the DB; `prisma migrate diff` is
   now clean end-to-end.
6. **Prisma client generated.**
7. **vitest: 36/36 files, 282/282 tests green.** The 3 "pre-existing" failing
   suites (`provisioning`, `isolation`, `lifecycle`) needed TWO fixes, not one:
   the local PG the plan predicted, **plus** blanking the Clerk keys in
   `vitest.config.ts` `test.env` — vitest loads `.env`, the dev Clerk keys made
   `clerkEnabled()` true, and `@clerk/nextjs/server`'s `server-only` guard
   throws under vitest. The suites are written for demo-mode auth ("no Clerk in
   tests"), and the config already declared independence from the local `.env`,
   so the override matches intent.
8. **tsc --noEmit clean.**
9. **Dev server booted in PG mode.** Boot-guard gap list (initial, expected):
   - `[backend-guard] data backend: postgres (control base on)`
   - CASHFLOWS has no Postgres model — writes throw (→ Phase 2)
   - Control-plane features (assignments, connections, outbox, catalogs)
     unavailable in PG mode (→ Phase 3)
   - `/app` correctly redirects to Clerk sign-in.

### Deviations / gotchas discovered
- **Postgres via portable EDB binaries, not Docker** (no container runtime on
  the box; user-level install, no admin).
- **Schema snapshot regeneration blocked:** `scripts/airtable-gen-schema.mjs`
  defaults to construction-template base `appXfwBLE6zBEL5Zr`, which lacks the
  app-runtime/legacy tables (running it bare guts `schema.generated.ts` — do
  NOT commit that). The checked-in snapshot was generated from
  `appharWaojouHgMeW`, but the PAT now gets **403** on that base (deleted or
  out of scope). Left the checked-in snapshot as-is; the stale-QUOTES.Assessment
  issue remains open until Phases 4/5 need it (regenerate against an accessible
  full base then, or ask owner for template access).
- **Dev-server memory:** the first cold Turbopack compile OOM-crashed the Node
  process ("Fatal process out of memory") and briefly exhausted system commit
  (even PowerShell failed with 0x800705AF). The compile is filesystem-cached,
  so restarts are far lighter — but this box is tight on RAM; avoid running
  vitest and the dev server simultaneously.
- Clerk dev instance logs "infinite redirect loop" warnings against stale
  browser cookies — cosmetic in dev, verify against a fresh session if it
  recurs.
- **Google Fonts blocked on this network → every page 500'd.**
  `next/font/google` (Montserrat in `src/app/layout.tsx`) downloads from
  fonts.gstatic.com at compile time; that host is blocked here and under
  Turbopack the failure is a fatal "Module not found". Fixed by vendoring the
  three used weights (latin 400/600/700, from `@fontsource/montserrat` 5.3.0
  via `npm pack` — no new dependency) into `src/app/fonts/` and switching to
  `next/font/local`. Also removes an external build-time dependency, which
  suits the compliance posture.

### Plan errata found in Phase 0
- (none in the plan text itself so far; the §2b tenancy reference in the
  owner's rules of engagement does not exist in the plan — see "Open questions"
  below.)

### Open questions for the owner (blocking later phases, not Phase 0)
1. ~~**§2b / database-per-client / "8 design rules" — MISSING.**~~ **RESOLVED
   2026-07-29:** owner confirmed the architecture is **database per client**.
   The referenced §2b never existed in the plan, so it has now been written
   into `docs/airtable-to-postgres-migration-plan.md` (§2b) with 8 design
   rules drafted by this session (control DB + N tenant DBs, registry-driven
   connection factory, single tenant schema/migration history, `orgId` kept as
   defense-in-depth, bounded client cache, registry-only cross-tenant ops).
   The rules are owner-vetoable; treated as constraints from Phase 2 onward.
2. PAT access to template base `appharWaojouHgMeW` (403) — re-scope or confirm
   the base is gone.

---

## Phase 1 — Make Postgres mode fully bootable (2026-07-29) — COMPLETE

### Results
- **Route walk: 119/119 page routes return 200 in PG mode** (demo auth, empty
  DB, seeded `demo-walk` org; `[id]`-style params probed with `1`). Zero
  server-side exceptions in the dev-server log for the whole walk.
- Missing-record detail routes render "Not Found" messaging gracefully (HTTP
  200 with not-found UI, not crashes).
- GET API probes: `/api/health` (+`?deep=1`), org search, actions/plan
  exports, `/api/uc1/vendor-prices` all 200; `/api/platform/scheduler` 503 =
  correct fail-closed with `CRON_SECRET` unset.
- **Zero PG-mode crashes to fix** — the plan expected some; the only
  every-page failure (Google Fonts) was already fixed in Phase 0.
- vitest 282/282 green; `tsc --noEmit` clean.

### Plan errata (corrected in the plan doc)
- Cashflow does NOT hard-fail on load in PG mode — the window renders on an
  empty DB; only writes throw (boot-guard wording was accurate, plan §Phase 1.1
  wasn't).
- Control-plane call sites do not "silently hit Airtable" in PG mode:
  `controlEnabled()` requires `airtableEnabled()`, so they no-op/fallback.

### Carried notes
- Browser-pane gotcha confirmed exactly as the plan warned: streamed RSC
  content may not paint on initial pane loads — page HTML via curl is the
  source of truth for content checks.
- Clerk keys remain commented out (demo mode) for ongoing development;
  restore for any auth-path work. Auth-on boot was verified in Phase 0.
- Cashflow window in PG mode currently renders an empty list via the legacy
  read path — Phase 2 replaces this with the Spec-12 ledger model.

---

## Phase 2 — Cashflow ledger model (started 2026-07-29)

### §2b received
Owner supplied the authoritative §2b (database-per-client) on 2026-07-29 —
now transcribed into the plan doc, replacing this session's interim draft.
Immediately applicable here: **rule 5** (composite `(orgId, airtableRecordId)`
uniqueness) shapes the new ledger model from day one; rules 1–2 (db.ts
guard-regex split, `db(ctx)` resolver) land in Phase 3.

### Done (2026-07-29) — COMPLETE
1. **`PlatConCashflowLedger` model** (Spec-12 per-transaction shape, columns
   1:1 with `cashflowSchema`), with `@@unique([orgId, airtableRecordId])` per
   §2b rule 5 — the first model with composite bridge uniqueness. Migration
   `20260729100000_cashflow_ledger` (generated via `migrate diff`, applied).
   Legacy `PlatConCashflow` kept unwired for pre-ledger dev data, per plan.
2. **Write delegate wired** in `recordWriter.ts` (`d(prisma.platConCashflowLedger)`)
   — form create, edit save, assistant writes and proposals all route through
   the standard delegate branch now.
3. **Reads switched to the ledger**: `cashflowSource.fromPostgres` (list
   window), `loadCashflowDetail` PG branch (edit form), `dashboardSource`
   PG chart, `jobContextSource` PG rollup (AI job context).
4. **Chart math cross-checked (plan §2.5):** the 2026-07-20 "cashflow net
   math" Critical was fixed in the window but NOT in the dashboard/job-context
   aggregations — they summed In+Out unsigned. All aggregation sites now use
   the window's signed-net convention (Out subtracts; Paid=actual, else
   projected). Fixed in both PG and Airtable branches for cross-backend
   consistency.
5. **Mover map**: `cashflow` entry added to `_map.mjs` (CASHFLOWS →
   platConCashflowLedger; status passes through untranslated so live-base
   drift surfaces in Phase 5 reconciliation; rows without a Job link skip+log
   because `jobId` is NOT NULL).
6. **Boot guard / diagnostics / config comments** updated: CASHFLOWS no longer
   an asymmetry; replaced with the cascade-engine gap (below).
7. **Tests**: new `cashflowLedger.test.ts` (create+audit, zod period
   validation, update, PG detail read, cross-org refusal). Suite 287/287
   green; tsc clean.
8. **Verified in the browser** with 7 seeded ledger rows on `demo-walk`:
   list window renders per-job ledger + trend chart; metric cards exact
   (In $195,000 / Out $115,500 / Net $79,500); detail edit form loads a row;
   dashboard Projected/Actual chart driven by the ledger across 4 periods.

### Found during Phase 2 (plan updated)
- **Cascade engine is entirely Airtable-gated** (`runCascades` early-returns
  unless `airtableEnabled(ctx)`; rules D/F/G + advisories are `core.*`-coupled
  and gate on `rec…` ids). No standing automation fires in PG mode. Added as
  Phase 3 item 8 in the plan — port, not redesign (PG models exist for
  everything the rules touch). Cashflow's cascade D therefore doesn't fire in
  PG mode yet; the ledger write path itself is proven by tests.
- `MASTER_IMPLEMENTATION_GUIDE.md` is at repo root, not `docs/` (plan §Phase 2.1
  says "see docs/").
- fieldMaps CASHFLOWS `createDefault: "Scheduled"` for Status conflicts with
  the app enum (Forecast/Confirmed/Paid/Overdue) — unreachable in practice
  (zod defaults Status before fieldMaps sees it); reconcile during Phase 5.

### Environment notes
- A dev server that survives a Prisma regenerate keeps the OLD client in
  memory (Unknown field errors) — always restart the dev server after
  `prisma generate`.
- A partially-wedged dev server 404'd every dynamic `[id]` route while list
  routes worked; restart fixed it (variant of the plan's wedged-server gotcha).
- One OOM crash left `.next/dev/types/validator.ts` torn mid-write → tsc
  errors; delete the file, Next regenerates it.
- Zombie node processes accumulate from Turbopack crashes on this box and can
  squat port 3000 / the Next dev lock / the Prisma DLL. A machine reboot would
  clear the herd; until then, kill by PID via the `.next/dev/lock` file.

---

## Phase 3 — Control plane to Postgres (started 2026-07-29)

### Stage A — repository layer (2026-07-29) — DONE (plan items 1–7 + exit criteria)

**Design:** one seam, `src/lib/platform/controlPlane.ts`, mirroring
`lib/airtable/control`'s full consumed surface (~35 functions, 8 concerns).
Each function branches internally: Airtable control base when
`controlEnabled()` (legacy, unchanged), else Postgres. New gate
`controlPlaneEnabled()` = Airtable-control OR PG mode — every platform feature
now gates on it; bare `controlEnabled()` survives only for genuinely
Airtable-only concerns (schema drift, base provisioning, registry-row snapshot
cache freshness). This satisfies plan §3.6 (no per-call-site branching; call
sites changed import path only) and Phase 6 deletes the airtable halves.

**PG store mapping:**
- Org registry = `PlatOrganisation` (it already was the PG registry; settings
  JSON helpers — metrics snapshot, webhook secret, generalJobId, RLS-enforce
  flag — merge into its `settings`; aiAuthority is a column).
  `PlatCtlOrgRegistry` is NOT used at runtime — it stays as the mover landing
  zone for the Airtable control-base export (Phase 4/5 merges it into
  PlatOrganisation). Offboarding soft-deactivates (preserves tenant data,
  mirroring the undeletable Airtable base) + removes control team/assignments.
- **Team moved from tenant-side `PlatCfgTeamMember` to control-side
  `PlatCtlTeamMember`** (slug-keyed) per §2b topology — auth must resolve
  before any tenant-DB connection. org-context, provisioning, onboarding's PG
  transaction, and 3 test suites updated; PlatCfgTeamMember remains only as
  legacy dev data (mover decision in Phase 4).
- Assignments = `PlatCtlAssignment` (jobRecId column holds Airtable rec… ids
  OR PG numeric ids as strings). **RLS now resolves on Postgres** — the
  fail-open/fail-closed semantics and `project_rls_enforce` flag work
  unchanged; recordWriter's auto-assign-creator-on-job-create now fires in PG
  mode too (was rec…-id-gated).
- Connections/Outbox/Report catalog/Template registry/Job catalog = their
  `PlatCtl*` models. **Outbox events in PG mode carry numeric entity/job ids
  as strings** (plan §3.4's "PG-native id story" — n8n side reworked Phase 6).
- Scheduler/org picker/hooks default-deny/team page/agents/integrations/
  reports/templates/onboarding rewired through the seam (~24 files; most were
  a pure import swap).

**Also done:** `scripts/seed-control-plane.mjs` (§3.7 — org + owner member +
curated job catalogs from `scripts/job-catalog-seed.json`, idempotent; run for
demo-walk: 34 construction + 12 roofing rows). Boot guard + diagnostics
updated.

**Verified:** boots with `AIRTABLE_CONTROL_BASE_ID` unset (commented out in
.env) — boot guard prints "control base off / control plane served from
Postgres"; org picker lists from PlatOrganisation; team page renders the
seeded PlatCtl owner + the project-assignments (RLS) UI, previously
Airtable-only; integrations page renders. tsc clean; vitest 38 files /
295 tests green (8 new controlPlane round-trip tests incl. RLS scoping via
PlatCtlAssignment, fail-open→scoped→cleared).

### Stage B1 — cascade engine on Postgres (2026-07-29) — DONE (plan §3.8)
- `runCascades` un-gated; rules D/F/G, advisories (record/load/dismiss) and
  `seedCascadeRules` are dual-store; `markRuleApplied`/`writeRuleLadder`/
  `setRuleOverrideLevel` gained PG branches (PG has no Last_Triggered column —
  accepted lossy).
- **Schema additions** the rules needed (`20260729200000_cascade_pg_fields`):
  `PlatActionHub.issueType/phaseId/riskId` and `PlatConPhase.rag` — these were
  `pgOmit` shims ("Airtable is system of record") that had to become real
  columns in a PG-native build. pgOmit removed from the action/phase registry
  entries; mover map now carries Issue_Type, the ISSUES→RISKS link and
  PHASES.RAG (action.phaseId stays PG-only — canonical ISSUES has no Phase
  link).
- Onboarding's PG transaction now seeds the 7 cascade rules (advisories
  Active, write rules Draft, owner_only), matching the Airtable branch.
- New `cascadePg.test.ts` (6 E2E tests through writeRecord's post-write hook):
  seeding idempotency, D upsert+re-fire, G create-once, F RAG floor,
  advisory lifecycle, bookkeeping. Suite: 39 files / 301 tests green.

### Stage B2 — §2b rule 5: composite bridge uniqueness (2026-07-29) — DONE
39 tenant models converted from `airtableRecordId @unique` (global) to
`@@unique([orgId, airtableRecordId])` via a schema transform; the 9
control-side models (PlatOrganisation + PlatCtl*) keep the global unique
(their rec-ids come from the single control base). Migration
`20260729210000_composite_bridge_uniqueness` (39 DROP + 39 CREATE UNIQUE
INDEX). No `src/` code queried by that key (verified); the movers'
org-scoped recMaps are compatible unchanged. No drift; 301/301 green.

### Stage B3.1 — physical control/tenant schema split (2026-07-29) — DONE
The §2b rule 1 split, executed exactly along the db.ts guard-regex line:
- **`prisma/control/schema.prisma`** (new): PlatOrganisation + the 8 PlatCtl*
  models; own migration history (`prisma/control/migrations`, baseline
  `20260729220000_control_baseline`); own generated client
  (`@prisma/control-client`); `CONTROL_DATABASE_URL`.
- **`prisma/schema.prisma`** is now the TENANT schema (78 models): control
  models removed, all 39 `org PlatOrganisation @relation` FKs dropped (tenant
  rows keep bare `orgId Int` — no cross-database FKs). Migration
  `20260729230000_control_plane_split` drops the FKs + the 9 control tables
  from the tenant DB. Verified: zero code included the `org` relation.
- **Local topology**: `aequilibri_control` DB created on the same cluster;
  control rows copied over id-preserving (1 org, 1 team member, 46 job-catalog
  rows) with sequences bumped, BEFORE the tenant-side drop. Both schemas
  drift-free against their DBs.
- **`db.ts` is the two-client seam** (§2b rules 1–2): tenant client keeps the
  org-isolation guard (rule 3 tripwire); control client is separate; the
  exported `prisma`/`prismaUnscoped` are dispatch proxies routing control-model
  property access to the control client — call sites unchanged. `controlDb`
  exported for control-plane transactions; **`db(ctx)`** exported as the
  §2b rule 2 resolver seam (returns the shared tenant client until per-org
  DBs are provisioned).
- **No cross-DB transactions** (§2b): controlPlane.setControlAssignments →
  `controlDb.$transaction`; onboarding's PG provisioning restructured to
  control-writes-first + tenant transaction + compensating control-row
  cleanup on failure.
- Movers/reset/seed scripts updated to use the control client for registry
  lookups. `npm run db:generate` / `db:migrate` cover both schemas.
- **Verified**: 301/301 tests green against the split databases; app boots —
  picker/org-resolution/team/assignments served from `aequilibri_control`,
  cashflow/projects/coordination from the tenant DB. (One wedged-server 404
  episode on dynamic routes after the switch — restart fixed, same known
  gotcha.)
- **Consequence for tests/dev**: deleting an org no longer cascades tenant
  rows (no cross-DB FK). Suites already clean by slug; orphaned tenant rows
  in the shared dev DB are inert (new org ids never collide).

### Stage B3.2 — tenant resolution, provisioning, fan-out, native RLS (2026-07-29) — DONE
- **db(ctx) resolves per-org databases** (§2b rule 2): the org's
  `settings.tenantDatabaseUrl` (set at provisioning) flows into
  `ctx.config`, so resolution is synchronous on the Phase D threading. No
  URL → shared default tenant DB. `dbUnscoped(ctx)` is the ops twin.
- **LRU-bounded per-URL client cache** (§2b rule 8): cap via
  `TENANT_CLIENT_CAP` (default 8), eviction disconnects in the background;
  every per-org client carries the same org-isolation guard + control-model
  dispatch. `tenantClientCacheSize()` exposed for diagnostics.
- **`scripts/provision-tenant-db.mjs`** (§2b topology: CREATE DATABASE +
  migrate + seed replaces template-base cloning): creates the DB, applies the
  full tenant migration history, applies the native RLS pin, and only with an
  explicit `--activate` writes `tenantDatabaseUrl` into the registry.
  Idempotent.
- **`scripts/migrate-all-tenants.mjs`** (§2b rule 6 fan-out): control DB →
  default tenant DB → every provisioned tenant from the registry (rule 7:
  enumeration via registry only), fail-fast, re-pins RLS after each deploy.
- **Native Postgres RLS** (§2b rule 4, `scripts/_tenant-rls.mjs`): each
  tenant DB holds exactly one org, so every org_id table gets ENABLE+FORCE
  ROW LEVEL SECURITY with a constant `org_pin` policy — no session variables.
  Caveat: superuser/BYPASSRLS connections bypass policies (local dev does;
  production must connect as a plain role — Phase 7 checklist item).
- **E2E-proven locally**: scratch org `tenant-e2e` (id 30) provisioned to
  `aequilibri_t_tenant_e2e` (12 migrations, RLS pin on 40 tables, activated);
  a write through db(ctx) landed in the org's own DB with the shared DB at
  zero rows for that org; fan-out covered control + default + the tenant.
  Scratch org then deactivated (DB kept as artifact). Permanent
  `dbSplit.test.ts` covers resolution + cache semantics + guard-on-resolved
  clients. Suite: 40 files / 304 tests green; tsc clean; app boots and
  serves.

### Stage B4 — the prisma.* → db(ctx) call-site sweep (2026-07-29) — DONE
**Phase 3 / §2b is now functionally complete.** 232 tenant-model call sites
across 58 files moved onto the db(ctx) resolver (codemod + tsc-driven triage);
tests keep `prisma` by design (they run against non-activated orgs).
Hand-fixed cases worth knowing:
- **recordWriter REGISTRY delegates** were captured at module load — they'd
  have pinned all writes to the shared DB forever. `d()` now resolves
  `db(ctx)` per call (`delegate(ctx)`), incl. audit-log + pending-write rows.
- **assistant executor QUERYABLE** map: same module-load capture, same fix.
- **scheduler**: `wantsAutoReports` takes ctx; the post-run summary write was
  a cross-org `createMany` — now per-org rows into each org's own DB.
- **diagnostics ROWS** count callbacks take ctx.
- **Public portal page**: token lookup stays deliberately cross-org on
  `prismaUnscoped` (searches the DEFAULT tenant DB only — see caveat below);
  the domain reads after it resolve the org's DB via its registry row.
- One type-level `typeof prisma...` kept (types identical across clients);
  documents.ingest test's db mock extended with `db: () => client`.

**Full-stack isolation proof:** with tenant-e2e reactivated, the APP served
`/app/tenant-e2e/projects` from `aequilibri_t_tenant_e2e` (its own database,
through org-context → db(ctx)) while `/app/demo-walk/projects` served from
the shared DB — no cross-contamination either way. Scratch org deactivated
again after the proof. Gates: tsc clean, 304/304 tests, app boots.

---

## Phase 4 — Excluded data + attachments (2026-07-29)

Owner decisions: **migrate chat/audit history; model CHANGE_LOG; drop
DOMAIN_LABELS + REGIONS.**

### Done
1. **`PlatConChangeLog`** model (migration `20260729240000_change_log`,
   fanned out to all DBs): the non-variation change register —
   variation rows keep mapping to PlatConVariationOrder; the `change_log`
   mover entry takes the complement (`Change_Type !== "Variation"`).
   Data-preservation model; no app window writes it yet.
2. **Seven new mover entries** in `_map.mjs`, each mirroring the module code's
   authoritative Airtable conventions (JSON riding in Evidence/Notes/
   Accuracy_Summary unpacked via pgDerive): `change_log`, `hypothesis`,
   `correction`, `intelligence_snapshot`, `chat_session`, `chat_message`,
   `execution_log`. Chat tables use the new **text-link** support
   (`text: true` — Session_Id/Job_Id are string fields, not record links).
3. **Control-base mover** `scripts/migration/airtable-control-to-pg.mjs`
   (Phase 4.4): PLAT_* → PlatCtl* landing zone + PlatOrganisation merge-by-
   slug. **Dry-run verified against the live control base** (read-only):
   7 orgs / 16 team / 3 connections / 3 outbox / 1 report template /
   3 template mappings / 66 job-catalog rows.
4. **Attachment pipeline** `scripts/migration/download-attachments.mjs`
   (Phase 4.5): downloads DOCUMENTS.File binaries during export (URLs expire
   ~2h), writes a per-org manifest, `--apply-refs` re-points PlatDocument
   storageProvider/storageRef (first file on the row; extras in the manifest).
   **Tested against BOTH live bases** (read-only): pipeline executes
   end-to-end; meta-API scan confirms DOCUMENTS.File is the ONLY attachment
   field on either base and both are currently EMPTY (Drive-URL storage is
   the norm) — so no binaries exist to move today; re-run at cutover catches
   any added later. Local dir → AU object storage sync is a Phase 7 ops step.
5. **Mover hardening for Phase 5**: `--target-url` (or the org's
   settings.tenantDatabaseUrl) routes rows into per-org tenant DBs;
   network-level fetch failures now retry like 5xx (flaky links must not
   kill checkpointed runs); absent tables (vertical differences — Meridian
   has no VENDORS) skip-and-log instead of aborting.
6. **PENDING_WRITES** confirmed excluded (the PG claim registry was always
   authoritative); DOMAIN_LABELS/REGIONS drop recorded; EXCLUDED list updated.
7. Meridian full-map dry run (read-only) exercises every entry incl. the new
   ones — mapper fallout found and fixed (absent-table 403). Fan-out script
   now covers DEACTIVATED orgs' DBs too (schema-current for reactivation).

### Known caveats carried forward
1. **Portal-token lookup** searches the default tenant DB only — before any
   org WITH PORTAL TOKENS is activated onto its own database, token
   resolution needs a control-side index (Phase 5 activation checklist).
2. Org **activation runbook** (Phase 5): provision DB → mover copies the
   org's rows into it → `--activate` → delete the org's rows from the shared
   DB. The mover currently writes to DATABASE_URL; give it a `--target-url`
   (or read the org's tenantDatabaseUrl) in Phase 4/5.
3. Tenant-URL encryption at rest + non-superuser app role (RLS effectiveness)
   — Phase 7 hardening.
4. Uc1* stays in the tenant schema, served by the default DB (org-less
   legacy demo) — confirmed direction, owner veto welcome.
Execution order chosen so every step keeps the app green:

1. **Split the Prisma schemas.** `prisma/schema.prisma` stays the TENANT
   schema (drop PlatOrganisation's tenant-side relations: tenant models keep
   bare `orgId Int` — no FK to the org — per no-cross-DB-FK; PlatOrganisation
   + PlatCtl* move out). New `prisma/control/schema.prisma` (PlatOrganisation
   + PlatCtl*, own migration history, generated client output
   `node_modules/@prisma/control-client` via generator `output`).
   `CONTROL_DATABASE_URL` env (falls back to DATABASE_URL in dev so a single
   local cluster still works).
2. **db.ts becomes the two-client seam** (§2b rules 1–2): `controlDb`
   (control client singleton) + `db(ctx)` (org → cached tenant client from
   the registry's connection string; LRU-bounded, §2b rule 8). During the
   transition `db(ctx)` returns the legacy shared client when the org has no
   `tenantDatabaseUrl` in its registry settings — so the split can roll out
   org-by-org (create DB → fan-out migrate → mover copy → flip the setting).
3. **Call-site migration**: `prisma.plat*` → `db(ctx).plat*` on the Phase D
   ctx threading (~150 sites); `controlPlane.ts` + org-context switch to
   `controlDb`. The org-guard extension moves onto the tenant client
   unchanged (rule 3 tripwire).
4. **Provisioning**: onboarding's PG path gains CREATE DATABASE + migrate +
   seed (replaces "clone template base"); `scripts/migrate-all-tenants.mjs`
   = the §2b rule 6 fan-out (control DB first, then every tenant from the
   registry, fail-fast).
5. **Native RLS** (§2b rule 4): per-tenant-DB policies on orgId once tenant
   DBs are single-org (policy: `USING (org_id = current_setting('app.org_id')::int)`,
   set per connection by db(ctx)).
6. **Uc1\*/legacy tables**: stay in the control/default DB (operator-internal
   roofing demo, not client data — putting them per-tenant would duplicate
   them). Confirm with owner before cutover.

### Notes / gotchas
- `templates/actions.ts` is UTF-16-encoded on disk (grep sees it as binary) —
  edit via tooling that preserves encoding.
- vitest's `vi.mock` paths had to follow the import-path change
  (outbox/rls-scoping suites mock `@/lib/platform/controlPlane` now).
- PlatCtl* rows are slug-keyed and NOT FK-cascaded with the org — test
  suites clean them explicitly.

### Setup notes
- Route walk runs in **demo mode** (Clerk keys temporarily commented out of
  `.env`): the walk needs an operator session, demo mode is
  operator-by-definition in development, and it matches how the test suite
  runs. Keys go back after Phase 1 auth-path checks.
- Seeded one empty org `demo-walk` (bare `PlatOrganisation` row, same shape the
  integration tests create) so `/app/[org]/*` routes resolve.
- **Dev-server stability on this box:** repeated OOM kills when >1 Turbopack
  instance runs (one wedged 2GB node held port 3000 + Next 16's
  one-dev-server-per-project lock and had to be force-killed). Rule: exactly
  one dev server, don't run vitest concurrently with it. Next 16 docs expose
  no Turbopack memory cap.

### Inventory: ~28 deliberately-global `airtableEnabled()` sites (plan §Phase 1.3)
33 grep hits for `airtableEnabled()` (no ctx): `uc1Source.ts` ×24,
`schemaDriftSource.ts` ×2, `api/health` ×2, `onboarding.ts` ×2,
`org-context.ts` ×1, `diagnostics/page.tsx` ×1, `airtable/generic.ts` ×1,
`airtable/tables/decisions.ts` ×1, plus the definition in
`airtable/control.ts` (`controlEnabled = airtableEnabled() && controlBaseId`).
**Decision:** all are `if (!airtableEnabled()) { …PG path }` guards that
already resolve to Postgres with the global flag off — converting them now
duplicates Phase 6's mechanical flag removal (and vitest/movers still read the
flag). Leave until Phase 6; nothing here blocks bootability.

### Inventory: control-plane touchpoints (all silently no-op/fallback in PG mode → Phase 3 worklist)
27 `controlEnabled(` sites: `app/actions.ts` ×3, `api/platform/hooks` ×1,
`airtable/config.ts` ×1 (per-org feature overrides!), `scheduler.ts` ×1,
`onboarding.ts` ×2, `[org]/agents/actions.ts` ×1, `app/page.tsx` ×1,
`jobCatalogSource.ts` ×1, `[org]/team/page.tsx` ×1, `org-context.ts` ×3,
`navCountsSource.ts` ×2, `outbox.ts` ×2, `provisioning.ts` ×3,
`recordWriter.ts` ×1, `rls.ts` ×1, `schemaDriftSource.ts` ×1.
