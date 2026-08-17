// Sidebar badge counts — Postgres. These run in the org layout on EVERY
// platform page.

import type { OrgMetricsSnapshot } from "@/lib/platform/controlPlane";
import { db, prisma } from "@/lib/db";
import { logger, errMeta } from "@/lib/logger";
import { excludeGeneral } from "./generalJob";
import { loadOrgHighlights } from "./orgHighlightsSource";
import { currentJobScope } from "./rls";
import type { OrgCtx } from "./types";

const ZERO_COUNTS: NavCounts = {
  jobs: 0,
  pending: 0,
  openActions: 0,
  openRisks: 0,
  openVariations: 0,
};

export interface NavCounts {
  jobs: number;
  pending: number;
  openActions: number;
  openRisks: number;
  openVariations: number;
}

function toCounts(m: OrgMetricsSnapshot): NavCounts {
  return {
    jobs: m.projects,
    pending: m.pendingApprovals,
    openActions: m.openActions,
    openRisks: m.openRisks,
    openVariations: m.openVariations,
  };
}

async function fromPostgres(ctx: OrgCtx, f: Record<string, boolean>): Promise<NavCounts> {
  const [jobs, pending, openActions, openRisks, openVariations] = await Promise.all([
    // Excludes the Organisation-wide bucket: this count drives both the nav
    // badge and nav.ts's `multiJob` switch, so counting it would give a
    // single-project org a projects list it should never see.
    db(ctx).platJob.count({ where: { orgId: ctx.orgId, ...excludeGeneral(ctx) } }),
    db(ctx).platPendingWrite.count({ where: { orgId: ctx.orgId, status: "proposed" } }),
    db(ctx).platActionHub.count({
      where: { orgId: ctx.orgId, status: { in: ["open", "in_progress"] } },
    }),
    f.risks
      ? db(ctx).platConRisk.count({ where: { orgId: ctx.orgId, status: "open" } })
      : Promise.resolve(0),
    f.variations
      ? db(ctx).platConVariationOrder.count({ where: { orgId: ctx.orgId, status: "submitted" } })
      : Promise.resolve(0),
  ]);
  return { jobs, pending, openActions, openRisks, openVariations };
}

/** Sidebar badge counts. These render in the org layout on every page, so a
 *  read failure must NOT crash the whole shell — degrade to zeros so
 *  admin/diagnostic pages stay reachable to fix the underlying problem. */
export async function loadNavCounts(ctx: OrgCtx): Promise<NavCounts> {
  try {
    // RLS: a whole-tenant viewer (exempt role, or scoping not enforced) gets
    // org-wide counts. A scoped viewer gets counts filtered to their jobs.
    const scope = await currentJobScope(ctx);
    if (scope.mode !== "all") {
      return toCounts({ ...(await loadOrgHighlights(ctx, scope)), at: "" });
    }
    return await fromPostgres(ctx, ctx.config.features);
  } catch (err) {
    logger.warn("Nav counts unavailable — degrading to zeros", {
      org: ctx.orgSlug,
      ...errMeta(err),
    });
    return ZERO_COUNTS;
  }
}
