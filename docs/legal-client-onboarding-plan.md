# Onboarding Meridian Legal Group (first legal client) — DEV

**Status:** IN PROGRESS — owner decision 2026-10-01: FULL migration + 'legal'
as a first-class vertical. Target = **dev** only (control-dev + t-default-dev).

## What we're working with (investigated 2026-10-01)

- **Source:** Supabase archive `aequilibri-archive-meridian-legal-group`
  (ref `eujihwyauzfetxgtbjmc`). Raw Airtable export in an `airtable` schema,
  36 tables. Every row has `record_id`, `created_time`, and **`_raw`** (the
  original Airtable `fields` object — verified on jobs: Job_Name, Status,
  Actual_Value, Engagement_Type, PHASES, …). Volumes: **3,001 jobs, 14,287
  phases, 460 contacts, 379 documents, 478 risks, 8 decisions.**
- **"Legal" = a terminology overlay, not a separate schema.** The archive's
  `domain_labels` table maps core→legal: JOBS.Job_Name→"Matter",
  Estimated_Value→"Estimated fees", Actual_Value→"Billed / WIP",
  CASHFLOWS.Cashflow_Name→"Fee / disbursement" (domain="Legal"). The generic
  project schema (jobs/phases/cashflows) is reused; legal is a re-skin.
- **Core template archive** `ciarlmsroumeqyrocsgu` — same `airtable` shape,
  26 tables; the generic template these clients were cloned from.
- **Gaps in the current Postgres platform:**
  1. `VERTICALS = ["construction","roofing"]` — no `legal` (src/app/(platform)/app/new).
  2. Domain-label overlay is STUBBED on PG: `getDomainLabels()` returns an
     empty Map (src/lib/platform/domainLabels.ts) — everything falls back to
     hardcoded construction labels. The feature exists; the PG data source
     was never built.
  3. The mover (`scripts/migration/airtable-to-pg.mjs` + `_map.mjs`) reads
     the **live Airtable API** (AIRTABLE_PAT + base). Airtable is being
     decommissioned → must read from the archive instead.

## Approach

Feed the existing mover from the archive SQL, not Airtable. The archive's
`_raw` IS the Airtable `fields` object, so an adapter reconstructs
`{ id: record_id, createdTime: created_time, fields: _raw }` per table — a
drop-in for `_shared.mjs listAll()`. `_map.mjs` then applies unchanged.

## Phases (all on the `dev` branch; deploy to dev; verify at dev URL)

- **L1 — Legal vertical (code).** Add `legal` to VERTICALS (onboarding page +
  actions), a legal label in VERTICAL_LABELS, a legal job-category catalog
  (scripts/…seed-job-catalog or ensureJobCatalog input), and confirm
  vocab.ts / industryTaxonomy.ts carry legal. Typecheck + test.
- **L2 — Domain labels on Postgres.** New control table (e.g.
  `plat_ctl_domain_label`: domain, coreTable, coreField, label, contextNote,
  active) + migration; wire `getDomainLabels()` to read it for the org's
  vertical; seed the Legal rows from the archive `domain_labels` table.
  Unit test for the overlay already exists (domainLabels.test.ts).
- **L3 — Onboard the org.** Create `meridian-legal-group` in control-dev:
  vertical=legal, engagement types from the archive
  (Long Project default / Ongoing / Short Job), assistant persona, admin
  (mac@ + claudia@). Via provisionOrganisation or a scripted seed.
- **L4 — Archive-source mover.** Build the archive adapter (reads
  `airtable.<table>` from `eujihwyauzfetxgtbjmc` via the Management API SQL
  endpoint, emits Airtable-record-shaped rows). Run the mover into
  t-default-dev for meridian-legal-group, table by table, respecting link
  order. Attachments (documents) later/optional in dev.
- **L5 — Verify.** Row-count parity archive↔plat per table; spot-check a
  matter end to end in the dev UI (renders as "Matter", fees, etc.);
  verification note like docs/migration-verification-*.

## Guardrails

- DEV ONLY. Nothing here touches prod control/tenant projects.
- Meridian lands on the shared t-default-dev (per-client DB still deferred);
  orgId-scoped like every other tenant. Same RLS-gap caveat as Didi applies
  in dev — acceptable for a dev migration.
- Keep prod asleep; this work does not require waking prod.
- Idempotent mover (matches on airtableRecordId) — re-runnable.
