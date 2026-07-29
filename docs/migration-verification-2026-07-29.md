# Data-migration verification report — 2026-07-29 (Phase 5)

Airtable → Postgres, executed against the **local** Postgres cluster
(staging-equivalent; the same runbook repeats at cutover). Airtable was
READ-ONLY throughout. §2b topology: each org landed in its **own tenant
database**; the control base landed in the **control database**.

| Target | Source base | Tenant DB | Result |
|---|---|---|---|
| Control plane | `app51Tmrgab3QYP4Z` | `aequilibri_control` | ✅ complete |
| Meridian Legal Group (org 82) | `appr9sReyIHgS6FXy` | `aequilibri_t_meridian_legal` | ✅ complete, 0 skips, counts exact |
| Dulong Downs Didi (org 80) | `appmDPKjRT4Kp9rvN` | `aequilibri_t_dulong_downs_didi` | ✅ complete, 0 skips after drift fixes, counts exact |

## 1. Control base → control DB

7 org-registry rows (merged into PlatOrganisation by slug), 16 team members,
0 assignments, 3 connections, 3 outbox rows, 1 report template, 3 template
mappings, 66 job-catalog rows. Landing-zone copies kept verbatim in
`PlatCtlOrgRegistry`.

## 2. Meridian Legal (~19.6k rows) — counts, both sides exact

CONTACTS 460 · JOBS 3,001 · PHASES 14,287 · DOCUMENTS 379 · RISKS 478 ·
DECISIONS 8 · BUDGET 561 · CASHFLOWS 643 · COMMS 363 · LEARNING_RULES 12 ·
CHAT_SESSIONS 2 · ENGAGEMENT_TYPE_CONFIG 3 · PLAT_CFG_SETTING 5. Absent on
the legal vertical (verified, not lost): VENDORS, QUOTES, QUOTE_LINES,
MEETING_MINUTES, WEEKLY_REPORTS, BIM_MODELS, PHASE_EVIDENCE.

Spot checks: matters render with real names/statuses; cashflow ledger
643 rows / **$5,958,200** total, all periods `YYYY-MM`; engagement types
normalized to the app union (2,142 short_job / 833 long_project /
26 ongoing_lifecycle); app serves `/app/meridian-legal` + cashflow +
projects from the org's own database.

Data-QA flag for the owner: Meridian JOB statuses are legal-vertical labels
("Closed – Settled" etc.) passed through raw — windows render them, but
status-filtered views treat them as non-active. Decide a status vocabulary
mapping before (or after) cutover; migration preserves the raw values.

## 3. Dulong Downs Didi (~1.6k rows) — counts, both sides exact

CONTACTS 29 · JOBS 2 · PHASES 10 · DOCUMENTS 21 · DECISIONS 28 · ISSUES 274 ·
BUDGET 44 · PROCUREMENT 236 · CASHFLOWS 532 · CHANGE_LOG 20 (+1 variation) ·
ROOM_MATRIX 61 · PLAN 171 · LEARNING_RULES 43 · HYPOTHESES 3 · CORRECTIONS 5 ·
INTELLIGENCE_SNAPSHOT 1 · CHAT 3 sessions / 10 messages · EXECUTION_LOG 116 ·
**ORGANISATIONS→vendors 47** · ENGAGEMENT_TYPE_CONFIG 1 · PLAT_CFG_SETTING 4 ·
REF_ZONES 6 + REF_BUDGET 9 (→ PlatCfgReference).

Spot checks: cashflow ledger 532 rows / **$13,968,275.87** total, zero
malformed periods; vendors window renders the recovered directory (The
Lighthouse Noosa, Beachwood, Noosa Hi-Fi…); plan/coordination/learning-rules
windows serve from the org's own database.

### Didi drift found and reconciled (the plan's predicted divergence)
| Drift | Reconciliation |
|---|---|
| No VENDORS table — vendor directory lives in Core ORGANISATIONS (Type="Vendor", 47 rows) | New `org_directory` map entry → PlatConVendor (name/industry/address/status) |
| CASHFLOWS.Period is a month LABEL ("June 2025"); 37 rows have none | `toPeriod()` normalization → `YYYY-MM`; period-less rows fall back to the record's created month |
| PHASES: `Sequence` instead of `Sort_Order`; `Start_Date`/`End_Date` present | Sequence→sortOrder fallback; date columns now mapped (benefits all bases) |
| RISKS: `Risk_Name`/`Probability` (select) instead of `Risk`/`Likelihood` | Fallback mapping; Probability High/Medium/Low → 4/3/2; Category/RAG/Notes preserved as a labelled suffix |
| CONTACTS split First_Name/Last_Name (+LinkedIn) | Name join fallback; LinkedIn into notes |
| JOBS legacy outcome-tracking columns (Outcome, Actual_Value, variance analysis…) | Preserved verbatim in `PlatJob.meta.airtableLegacy` JSON |
| DECISIONS register richer than app schema (Decision_Made, Reversibility, Confidence…) | Columns with PG homes mapped (alternatives/category); the rest as a labelled rationale block |
| ISSUES Trigger_Condition/Completion_Date/Notes | Preserved in `PlatActionHub.context.airtableLegacy` JSON |
| LEARNING_RULES: 36 legacy rules without Instance codes, text in Operational_Directive, prose Rule_Type | Stable derived codes (`LRN-<recid>`), description fallback, kind normalization |
| JOBS has no `code` column (PlatJob.code required) | Stable derived code `A-<recid>` (affects every base; latent since mover v1 was never live-run) |

## 4. Accepted losses (owner sign-off requested)

Thin/derivable fields with no PG home, passed over by design — full
field-level detail in `var/migration/drift-{didi,meridian}.json`:
- BUDGET: Forecast, Variance (computed), RAG
- PROCUREMENT: Unit, Order_Date, **Actual_Date, Invoice_Reference, Notes** ← the three worth a second look
- ROOM_MATRIX: Room_Type, Length_m/Width_m/Ceiling_Height_m (renamed dims; template columns Area_Sqm etc. empty on live bases)
- PHASES: Phase_Type, Loop_Permitted, Notes
- COMMS: Comms_Name (display duplicate of Topic)
- LEARNING_RULES: Taught_By, Last_Triggered, Source_Correction, User_Preference_Profile
- CORRECTIONS: Correction_ID, Date_Found, Resolution_Status, Rule_Generated
- INTELLIGENCE_SNAPSHOT: display/duplicate columns (Snapshot_Name, Description…)
- RISKS (Meridian): Impact_Level (select duplicate of numeric Impact)
- Reverse-link echo fields everywhere (relations already carried by the forward FK)

Also intentionally not migrated: PENDING_WRITES (PG registry was always
authoritative), DOMAIN_LABELS + REGIONS (dropped — owner decision),
TRADE_PACKAGES / QUANTITY_TAKEOFF / CONTRACTOR_BIDS / BID_LINE_ITEMS /
MATERIALS_CATALOGUE (zero rows on every base; no PG models).

## 5. Attachments

Meta-API scan of both bases: `DOCUMENTS.File` is the only attachment field,
and it is EMPTY on both. Nothing to download today; the pipeline
(`download-attachments.mjs`) re-runs at cutover to catch anything added.

## 6. Re-run / cutover notes

- Everything is idempotent on `(orgId, airtableRecordId)` — the cutover
  incremental run is the same command per org.
- Runbook per org: `provision-tenant-db.mjs --slug X --activate` →
  `airtable-to-pg.mjs --org X --execute` → verify block prints counts.
- Checkpoints in `var/migration/<org>-air-to-pg.json`; delete to force a
  full pass (safe).
- Mover fixes that emerged live: absent-table tolerance, network retry,
  `noCreatedAt` models (PlatCfgSetting/ChatSession/IntelligenceSnapshot),
  column-width slicing, job-code derivation.
