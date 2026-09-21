// Lightweight org counts for the client-picker cards and the sidebar nav
// badges — the single compute behind the OrgMetricsSnapshot cached on the org's
// registry row (see control.ts). Status/field conventions mirror
// dashboardSource exactly so the numbers match the org dashboard.

import { db, prisma } from "@/lib/db";
import { excludeGeneral } from "./generalJob";
import { type JobScope } from "./rls";
import type { OrgCtx } from "./types";

export interface OrgHighlights {
  projects: number;
  openActions: number;
  overdueActions: number;
  pendingApprovals: number;
  openRisks: number;
  openVariations: number;
}

async function fromPostgres(ctx: OrgCtx, scope?: JobScope): Promise<OrgHighlights> {
  const f = ctx.config.features;
  const ids = scope && scope.mode === "some" ? [...scope.jobIds].map(Number).filter((n) => Number.isFinite(n)) : null;
  const jobW = ids ? { jobId: { in: ids } } : scope && scope.mode === "none" ? { jobId: -1 } : {};
  const ownW = ids ? { id: { in: ids } } : scope && scope.mode === "none" ? { id: -1 } : {};
  const [projects, openActions, overdueActions, pendingApprovals, openRisks, openVariations] =
    await Promise.all([
      // The Organisation-wide bucket is not a project — never counted as one.
      db(ctx).platJob.count({ where: { orgId: ctx.orgId, ...ownW, ...excludeGeneral(ctx) } }),
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
  return fromPostgres(ctx, scope);
}
