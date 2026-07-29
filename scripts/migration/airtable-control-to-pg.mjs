// Control-base mover (migration-plan Phase 4.4, pairs with Phase 3): copies
// the Airtable control base's PLAT_* tables into the CONTROL database's
// PlatCtl* models — and merges the org registry into PlatOrganisation, the
// runtime registry (PlatCtlOrgRegistry is kept verbatim as the landing zone).
//
//   node scripts/migration/airtable-control-to-pg.mjs [--base appXXX] [--execute]
//
// Reads AIRTABLE_CONTROL_BASE_ID (or --base) + AIRTABLE_PAT; READ-ONLY on the
// Airtable side. Dry-run by default; idempotent via airtableRecordId (control
// models keep the global unique — one control base per deployment) and via
// slug for the PlatOrganisation merge.

import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";
import { envVar, listAll } from "./_shared.mjs";

const execute = process.argv.includes("--execute");
const baseArgIdx = process.argv.indexOf("--base");
const baseId =
  (baseArgIdx > -1 ? process.argv[baseArgIdx + 1] : null) ?? process.env.AIRTABLE_CONTROL_BASE_ID;
if (!baseId) throw new Error("Pass --base appXXX or set AIRTABLE_CONTROL_BASE_ID.");
envVar("AIRTABLE_PAT");
envVar("CONTROL_DATABASE_URL");

const S = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
const N = (v) => (typeof v === "number" ? v : Number(v) || 0);
const B = (v) => v !== false; // Airtable checkboxes: absent = true convention (Is_Active)
const D = (v) => (typeof v === "string" && v ? new Date(v) : null);

const controlDb = new ControlPrismaClient();

/** table → {model, map(fields) → data}. Field names match lib/airtable/control.ts. */
const TABLES = [
  {
    air: "PLAT_ORG_REGISTRY", model: "platCtlOrgRegistry",
    map: (f) => ({
      slug: S(f["Slug"]), name: S(f["Name"]), orgId: N(f["Org_Id"]) || null,
      vertical: S(f["Vertical"]) || "construction",
      defaultEngagementType: S(f["Default_Engagement_Type"]) || "long_project",
      allowedEngagementTypes: S(f["Allowed_Engagement_Types"]) || "[]",
      aiAuthority: S(f["Ai_Authority"]) || "approve_required",
      settings: S(f["Settings"]) || "{}",
      isActive: B(f["Is_Active"]), airtableBaseId: S(f["Airtable_Base_Id"]) || null,
    }),
    filter: (f) => !!S(f["Slug"]),
  },
  {
    air: "PLAT_TEAM", model: "platCtlTeamMember",
    map: (f) => ({
      orgSlug: S(f["Org_Slug"]), email: S(f["Email"]), name: S(f["Name"]),
      role: S(f["Role"]) || "member", isActive: B(f["Is_Active"]),
    }),
    filter: (f) => !!S(f["Org_Slug"]) && !!S(f["Email"]),
  },
  {
    air: "PLAT_ASSIGNMENTS", model: "platCtlAssignment",
    map: (f) => ({
      orgSlug: S(f["Org_Slug"]), email: S(f["Email"]).toLowerCase(), jobRecId: S(f["Job_Rec_Id"]),
    }),
    filter: (f) => !!S(f["Org_Slug"]) && !!S(f["Email"]) && !!S(f["Job_Rec_Id"]),
  },
  {
    air: "PLAT_CONNECTIONS", model: "platCtlConnection",
    map: (f) => ({
      orgSlug: S(f["Org_Slug"]), channel: S(f["Channel"]),
      direction: S(f["Direction"]) === "out" ? "out" : "in",
      connectionKey: S(f["Connection_Key"]), credentialRef: S(f["Credential_Ref"]),
      eventFilter: S(f["Event_Filter"]), isActive: B(f["Is_Active"]),
      lastEventAt: D(f["Last_Event_At"]), lastStatus: S(f["Last_Status"]), notes: S(f["Notes"]),
    }),
    filter: (f) => !!S(f["Org_Slug"]),
  },
  {
    air: "PLAT_OUTBOX", model: "platCtlOutbox",
    map: (f) => ({
      orgSlug: S(f["Org_Slug"]), event: S(f["Event"]), entityType: S(f["Entity_Type"]),
      entityId: S(f["Entity_Id"]), jobId: S(f["Job_Id"]), payload: S(f["Payload"]) || "{}",
      summary: S(f["Summary"]), status: S(f["Status"]) || "pending",
      attempts: N(f["Attempts"]), lastError: S(f["Last_Error"]), deliveredAt: D(f["Delivered_At"]),
    }),
    filter: (f) => !!S(f["Org_Slug"]),
  },
  {
    air: "PLAT_REPORT_CATALOG", model: "platCtlReportCatalog",
    map: (f) => ({
      orgSlug: S(f["Org_Slug"]), key: S(f["Key"]), title: S(f["Title"]),
      prompt: S(f["Prompt"]), scopes: S(f["Scopes"]) || "", source: S(f["Source"]),
      isActive: B(f["Is_Active"]),
    }),
    filter: (f) => !!S(f["Org_Slug"]) && !!S(f["Key"]),
  },
  {
    air: "PLAT_TEMPLATE_REGISTRY", model: "platCtlTemplateRegistry",
    map: (f) => ({
      verticalKey: S(f["Vertical_Key"]), industry: S(f["Industry"]),
      subIndustry: S(f["Sub_Industry"]), templateBaseId: S(f["Template_Base_Id"]),
      sortOrder: N(f["Sort_Order"]), isActive: B(f["Is_Active"]), notes: S(f["Notes"]),
    }),
    filter: (f) => !!S(f["Vertical_Key"]),
  },
  {
    air: "PLAT_JOB_CATALOG", model: "platCtlJobCatalog",
    map: (f) => ({
      verticalKey: S(f["Vertical_Key"]), key: S(f["Key"]), label: S(f["Label"]),
      categoryGroup: S(f["Category_Group"]), engagementType: S(f["Engagement_Type"]) || "short_job",
      scopeHint: S(f["Scope_Hint"]), phases: S(f["Phases"]) || "[]",
      sortOrder: N(f["Sort_Order"]), source: S(f["Source"]) || "curated",
      isActive: B(f["Is_Active"]),
    }),
    filter: (f) => !!S(f["Vertical_Key"]) && !!S(f["Key"]),
  },
];

const summary = [];
for (const t of TABLES) {
  let records = [];
  try {
    records = (await listAll(baseId, t.air)).filter((r) => t.filter(r.fields));
  } catch (err) {
    summary.push({ table: t.air, error: String(err.message).slice(0, 60) });
    continue; // tolerate absent tables (older control bases)
  }
  let created = 0, updated = 0;
  for (const rec of records) {
    const data = t.map(rec.fields);
    if (!execute) {
      const existing = await controlDb[t.model].findFirst({ where: { airtableRecordId: rec.id } });
      existing ? updated++ : created++;
      continue;
    }
    await controlDb[t.model].upsert({
      where: { airtableRecordId: rec.id },
      update: data,
      create: { ...data, airtableRecordId: rec.id },
    });
    created++; // upsert — counted as touched
  }
  summary.push({ table: t.air, rows: records.length, touched: execute ? created : `${created} new / ${updated} existing (dry)` });
}

// ── Merge the registry into the RUNTIME registry (PlatOrganisation) ─────────
// The landing-zone rows above are verbatim; the app resolves orgs from
// PlatOrganisation, so registry entries are merged by slug: existing PG orgs
// (created pre-migration) get their Airtable base id + settings backfilled;
// unseen orgs are created.
const regRows = await controlDb.platCtlOrgRegistry.findMany();
let merged = 0;
for (const r of regRows) {
  if (!execute) continue;
  const existing = await controlDb.platOrganisation.findFirst({ where: { slug: r.slug } });
  if (existing) {
    await controlDb.platOrganisation.update({
      where: { id: existing.id },
      data: {
        name: r.name, vertical: r.vertical,
        defaultEngagementType: r.defaultEngagementType,
        allowedEngagementTypes: r.allowedEngagementTypes,
        aiAuthority: r.aiAuthority, settings: r.settings,
        isActive: r.isActive, airtableBaseId: r.airtableBaseId,
        airtableRecordId: r.airtableRecordId,
      },
    });
  } else {
    await controlDb.platOrganisation.create({
      data: {
        slug: r.slug, name: r.name, vertical: r.vertical,
        defaultEngagementType: r.defaultEngagementType,
        allowedEngagementTypes: r.allowedEngagementTypes,
        aiAuthority: r.aiAuthority, settings: r.settings,
        isActive: r.isActive, airtableBaseId: r.airtableBaseId,
        airtableRecordId: r.airtableRecordId,
      },
    });
  }
  merged++;
}
summary.push({ table: "→ PlatOrganisation merge", rows: regRows.length, touched: execute ? merged : "(dry)" });

console.table(summary);
console.log(execute ? "EXECUTED." : "Dry run — re-run with --execute to write.");
await controlDb.$disconnect();
