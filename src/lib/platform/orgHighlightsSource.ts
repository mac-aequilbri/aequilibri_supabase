// Lightweight org counts for the client-picker cards and the sidebar nav
// badges — the single compute behind the OrgMetricsSnapshot cached on the org's
// registry row (see control.ts). Status/field conventions mirror
// dashboardSource exactly so the numbers match the org dashboard.
//
// Count-only tables are read with the status filter pushed into
// filterByFormula, so the response carries just the matching rows instead of
// the whole table. Two exceptions, both to share one cached request with other
// readers in the same render: ISSUES stays a full read (open/in-progress is
// resolved through the per-org status map app-side, and the dashboard reads
// the identical list), and RISKS uses the register's exact opts (jobs list +
// risk register + coordination all read it unfiltered). RISKS/VARIATIONS are
// optional Domain-tier tables on supplied bases — a base without them must
// count 0, not fail the whole batch.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { resolveActionStatus } from "./actionStatus";
import { loadActionStatusMap } from "./configSource";
import { listOptional } from "./optionalList";
import { PROPOSED_PENDING_FORMULA } from "./pendingWritesSource";
import { inScope, type JobScope } from "./rls";
import type { OrgCtx } from "./types";

function firstLink(v: unknown): string | null {
  return Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
}

export interface OrgHighlights {
  projects: number;
  openActions: number;
  overdueActions: number;
  pendingApprovals: number;
  openRisks: number;
  openVariations: number;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Spec 12: variations are CHANGE_LOG rows (Change_Type="Variation"). "submitted"
// maps to CHANGE_LOG's "Pending"; a blank status still counts as open-ish (see
// dashboardSource/navCounts history).
const SUBMITTED_VARIATIONS_FORMULA = `AND({Change_Type}='Variation',OR({Status}='Pending',{Status}=BLANK()))`;

async function fromAirtable(ctx: OrgCtx, scope?: JobScope): Promise<OrgHighlights> {
  const f = ctx.config.features;
  const [jobRowsAll, actionRowsAll, pendingRowsAll, riskRowsAll, variationRowsAll, statusMap] = await Promise.all([
    core.list(ctx.orgSlug, "JOBS", { maxRecords: 200 }),
    core.list(ctx.orgSlug, "ISSUES", { maxRecords: 1000 }),
    core.list(ctx.orgSlug, "PENDING_WRITES", { maxRecords: 1000, filterByFormula: PROPOSED_PENDING_FORMULA }),
    // Same opts as loadRisks/loadJobsList so a dashboard render reuses their read.
    f.risks ? listOptional(ctx.orgSlug, "RISKS", { maxRecords: 500 }) : Promise.resolve([]),
    f.variations
      ? listOptional(ctx.orgSlug, "CHANGE_LOG", { maxRecords: 1000, filterByFormula: SUBMITTED_VARIATIONS_FORMULA })
      : Promise.resolve([]),
    loadActionStatusMap(ctx),
  ]);

  // RLS: when a viewer scope is supplied and not whole-tenant, filter each read
  // to the viewer's jobs before counting (org-global rows always count).
  const scoped = scope !== undefined && scope.mode !== "all";
  const jobRows = scoped ? jobRowsAll.filter((r) => inScope(scope, r.id)) : jobRowsAll;
  const actionRows = scoped ? actionRowsAll.filter((r) => inScope(scope, firstLink(r["Job"]))) : actionRowsAll;
  const pendingRows = scoped ? pendingRowsAll.filter((r) => inScope(scope, str(r["Job_Id"]) || null)) : pendingRowsAll;
  const riskRows = scoped ? riskRowsAll.filter((r) => inScope(scope, firstLink(r["Job"]))) : riskRowsAll;
  const variationRows = scoped ? variationRowsAll.filter((r) => inScope(scope, firstLink(r["Job"]))) : variationRowsAll;

  const now = Date.now();
  const openActionRows = actionRows.filter((a) => {
    const res = resolveActionStatus(str(a["Status"]), statusMap);
    return res.clean && (res.canonical === "open" || res.canonical === "in_progress");
  });
  const overdueActions = openActionRows.filter((a) => {
    const d = str(a["Due_Date"]);
    return d && new Date(d).getTime() < now;
  }).length;

  return {
    projects: jobRows.length,
    openActions: openActionRows.length,
    overdueActions,
    pendingApprovals: pendingRows.length,
    openRisks: riskRows.filter((r) => (str(r["Status"]) || "open") === "open").length,
    openVariations: variationRows.length,
  };
}

async function fromPostgres(ctx: OrgCtx, scope?: JobScope): Promise<OrgHighlights> {
  const f = ctx.config.features;
  const ids = scope && scope.mode === "some" ? [...scope.jobIds].map(Number).filter((n) => Number.isFinite(n)) : null;
  const jobW = ids ? { jobId: { in: ids } } : scope && scope.mode === "none" ? { jobId: -1 } : {};
  const ownW = ids ? { id: { in: ids } } : scope && scope.mode === "none" ? { id: -1 } : {};
  const [projects, openActions, overdueActions, pendingApprovals, openRisks, openVariations] =
    await Promise.all([
      db(ctx).platJob.count({ where: { orgId: ctx.orgId, ...ownW } }),
      db(ctx).platActionHub.count({ where: { orgId: ctx.orgId, status: { in: ["open", "in_progress"] }, ...jobW } }),
      db(ctx).platActionHub.count({
        where: { orgId: ctx.orgId, status: { in: ["open", "in_progress"] }, dueDate: { lt: new Date() }, ...jobW },
      }),
      db(ctx).platPendingWrite.count({ where: { orgId: ctx.orgId, status: "proposed", ...jobW } }),
      f.risks
        ? db(ctx).platConRisk.count({ where: { orgId: ctx.orgId, status: "open", ...jobW } })
        : Promise.resolve(0),
      f.variations
        ? db(ctx).platConVariationOrder.count({ where: { orgId: ctx.orgId, status: "submitted", ...jobW } })
        : Promise.resolve(0),
    ]);
  return { projects, openActions, overdueActions, pendingApprovals, openRisks, openVariations };
}

/** Org counts. Pass a viewer `scope` (from resolveJobScope) to filter to that
 *  viewer's jobs; omit it for the org-wide snapshot (org-picker cards). */
export function loadOrgHighlights(ctx: OrgCtx, scope?: JobScope): Promise<OrgHighlights> {
  return airtableEnabled(ctx) ? fromAirtable(ctx, scope) : fromPostgres(ctx, scope);
}
