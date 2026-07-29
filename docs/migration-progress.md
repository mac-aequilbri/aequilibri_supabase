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
1. **§2b / database-per-client / "8 design rules" — MISSING.** The rules of
   engagement say tenancy is decided as database-per-client per plan §2b with 8
   design rules. The plan has no §2b, and no doc in the repo mentions
   database-per-client; the switch audit explicitly describes the current
   design as a **single shared DB with per-row `orgId`** ("Tenancy design is
   sound: every `Plat*` model carries `orgId` … single shared DB"). Need the
   actual §2b text (or the 8 rules) before Phase 2 (new cashflow model) and
   Phase 3 (control plane), where tenancy shape is load-bearing.
2. PAT access to template base `appharWaojouHgMeW` (403) — re-scope or confirm
   the base is gone.
