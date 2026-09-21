# Data-migration verification report v2 — 2026-08-17 (Workstream C1/C2)

Airtable → **Supabase** (ap-southeast-2), executed for **Dulong Downs Didi**.
Airtable was READ-ONLY throughout. Supersedes the local-cluster run recorded in
`docs/migration-verification-2026-07-29.md` (that cluster is gone; the Supabase
stack was rebuilt 2026-08-14).

| Target | Source base | Supabase project | Result |
|---|---|---|---|
| Dulong Downs Didi (org **2**) | `appmDPKjRT4Kp9rvN` | `aequilibri-t-default` (`ftodudqphxtyncxjhkhk`) | ✅ complete, 0 skips, counts exact |
| Control plane | — (org registered natively) | `aequilibri-control` (`xpiqrxveestyeaxsebdu`) | ✅ org + owner seeded |

**Topology deviation (owner decision 2026-08-17):** Didi landed in the shared
`aequilibri-t-default` project rather than a dedicated `aequilibri-t-dulong-downs-didi`
project, and the other client org was removed so Didi is the sole tenant. This is a
deliberate departure from §2b rule "one tenant DB per org" — see *Open items* below.

## 1. Pre-flight: base drift re-checked

`scripts/migration/check-drift.mjs` re-run against the live base
(`var/migration/drift-didi-2026-08-17.json`). **No new schema drift** since the
July reconciliation — every difference versus the July report is explained by
map extensions committed on 2026-07-29 *after* that snapshot was taken, not by
changes on the base.

Row census versus the July report: the base is effectively frozen —
**+2 `CHAT_MESSAGES` (10→12) and +2 `EXECUTION_LOG` (116→118)**; every other
table identical.

## 2. Counts — both sides exact

CONTACTS 29 · JOBS 2 · PHASES 10 · DOCUMENTS 21 · DECISIONS 28 · ISSUES 274 ·
BUDGET 44 · PROCUREMENT 236 · CASHFLOWS 532 · CHANGE_LOG 20 (+1 variation) ·
ROOM_MATRIX 61 · PLAN 171 · LEARNING_RULES 43 · HYPOTHESES 3 · CORRECTIONS 5 ·
INTELLIGENCE_SNAPSHOT 1 · CHAT 3 sessions / 12 messages · EXECUTION_LOG 118 ·
**ORGANISATIONS→vendors 47** · ENGAGEMENT_TYPE_CONFIG 1 · PLAT_CFG_SETTING 4 ·
REF_ZONES 6 + REF_BUDGET 9 (→ PlatCfgReference, 15 total).

**Total: 1,681 rows** under `org_id = 2`, matching the Airtable census exactly.
**0 skips, 0 unresolved links.**

Absent on this base (verified, not lost): VENDORS, QUOTES, QUOTE_LINES,
MEETING_MINUTES, WEEKLY_REPORTS, BIM_MODELS, PHASE_EVIDENCE. Empty on this base:
WORKSTREAMS, RISKS, COMMS, ASSESSMENTS.

Reading the mover's verification table: `REF_ZONES`/`REF_BUDGET`/`PLAT_CFG_REFERENCE`
each report `postgres=15` because all three map into the single `PlatCfgReference`
model (0 + 6 + 9 = 15). Not a discrepancy.

## 3. Spot checks

- **Cashflow ledger:** 532 rows, **$13,968,275.87** total — matches the July run
  to the cent. **0 malformed periods** (all `YYYY-MM`).
- **Vendor directory** recovered from Core ORGANISATIONS: The Lighthouse Noosa,
  Noosa Hi-Fi, BBQ & Fireplace Ctr, Beachwood…
- **Jobs:** `Dulong Downs [Active]`, `General [intake]`.
- **Phases** in correct sequence 1–10: Design → Tender → Base/Slab → Structure →
  Rough-In → Envelope → Fit-out → Fit-off → External → Completion.
- **Link integrity:** issues→job 274/274 · procurement→job 236/236 ·
  chat messages→session 12/12 (6/2/4) · plan→phase **104/171**, which matches
  Airtable exactly (67 PLAN rows genuinely carry no Phase link).
- **Bridge ids:** 0 null `airtableRecordId` on migrated tables.

## 4. Idempotency proven

The mover was re-run end-to-end with `--execute` after clearing the checkpoint:
**0 creates, 1,681 updates, 0 skips, 0 unresolved links.** This is exactly the
operation the cutover's final incremental pass performs.

## 5. Attachments

The base's `DOCUMENTS.File` attachment field exists but **all 21 rows are empty** —
they are generated reports (AI_Analysis payloads), not uploaded binaries.
`download-attachments.mjs --apply-refs` ran and correctly found 0 files.
**No attachment binaries exist for this client**, so the expiring-URL risk does
not apply here.

## 6. Other client removed (owner instruction)

`aamayah-stella-builders` (org 1) deleted so Didi is the only client:
**3,458 synthetic rows across 33 tenant tables**, plus its control-plane org row
and 1 team member. This was seeded test data — regenerable via
`scripts/seed-aamayah-stella.mjs`. Global job catalogs (26 rows) were kept.

Post-delete state: `org_id = 1` → 0 rows; `org_id = 2` → 1,681 rows; control
registry holds exactly one org.

## 6b. General bucket wired (corrected 2026-08-17, post-migration)

The base's "General" job migrated as `PlatJob id 98`, but two things were missing
after the initial registry write:

- `plat_core_job.engagement_type` was `long_project` → set to **`general`**
  (per `docs/archive/project-general-bucket-plan.md`, the PG backend carries the
  type on the column).
- The org registry had no `generalJobId` → set to **`"98"`** (string; the type is
  `generalJobId?: string` and `findGeneralJob` compares ids as strings).

This matters because `resolveJobScope` (`src/lib/platform/rls.ts:65`) reads
`ctx.config?.generalJobId` with **no name fallback** — unlike `findGeneralJob`,
which does fall back to a name lookup. Left unset, an enforcing viewer with no
assignments would resolve to `{mode:"none"}` and General would be in nobody's
scope. No live impact yet: `project_rls_enforce` is not enabled for this org, so
scoping is still fail-open.

## 7. Open items

1. **No native RLS on `aequilibri-t-default`** — the project has 0 policies and
   0 RLS-enabled tables, so §2b rule 4's hard database wall is absent while the
   project now holds real client data. The app-level `orgId` guard (rule 3) is
   the only isolation. Applying the org-2 pin was **not** done unilaterally
   because `applyTenantRlsPin` binds `org_id = current_setting('app.org_id')`,
   and if the shared/default code path does not set `app.org_id` per connection
   the pin would deny every query and take the app down. **Verify that seam,
   then apply the pin.**
2. **`.env` is stale** — `DATABASE_URL`/`CONTROL_DATABASE_URL` still point at
   deleted project refs (`ktfzidsg…`, `mmwppoqu…`). The app cannot connect until
   the live `aequilibri_app` credentials for `ftodudqphxtyncxjhkhk` /
   `xpiqrxveestyeaxsebdu` are restored from Secrets Manager.
3. **Temporary ops role** `aequilibri_ops_migration` was minted on both projects
   via the Management API SQL endpoint to run this migration without touching
   the deployed app's credential, and **dropped on completion**.
4. **Dedicated tenant project** — if the §2b one-project-per-client topology is
   restored later, Didi moves out by `pg_dump -Fc --no-owner --no-acl` →
   `pg_restore`, per plan C1.
5. **C5 still outstanding** — Didi loses direct Airtable base access at cutover;
   the client conversation about what replaces it is a documented blocker for C3.
6. Airtable remains the source of truth. No freeze, no DNS switch, no PAT
   revocation has occurred — this is the soak-stage materialisation, not cutover.
