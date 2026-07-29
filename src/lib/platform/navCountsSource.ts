// Sidebar badge counts — Postgres (default) or Airtable when the flag is on.
// These run in the org layout on EVERY platform page, so in Airtable mode they
// must not fan out list-reads per render. The counts are served from the
// OrgMetricsSnapshot cached on the org's registry row: that row is already
// fetched (and TTL-cached in-process) by getOrgRegistry under resolveBaseId,
// so a fresh snapshot costs ZERO extra Airtable requests. When the snapshot is
// stale — or this process has written to the org's base since it was taken —
// the counts are recomputed from filtered reads (loadOrgHighlights) and
// written through, so the next minute of page renders is free again.
//
// pending (approval queue) is counted from PENDING_WRITES in Airtable mode.

import { airtableEnabled, lastWriteAt } from "@/lib/airtable";
import {
  controlEnabled,
  getOrgRegistry,
  readMetricsSnapshot,
  saveMetricsSnapshot,
  type OrgMetricsSnapshot,
} from "@/lib/platform/controlPlane";
import { db, prisma } from "@/lib/db";
import { logger, errMeta } from "@/lib/logger";
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

/** How long a registry-row snapshot may serve nav badges before the layout
 *  recomputes it. Matches the 60s control-plane staleness contract; in-app
 *  writes bypass it immediately via lastWriteAt. */
const NAV_SNAPSHOT_TTL_MS = 60_000;

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

async function fromAirtable(ctx: OrgCtx): Promise<NavCounts> {
  // 1) The cached-registry-row fast path: no Airtable reads at all.
  if (controlEnabled()) {
    const entry = await getOrgRegistry(ctx.orgSlug);
    const snap = entry ? readMetricsSnapshot(entry.settings) : null;
    if (snap) {
      const takenAt = new Date(snap.at).getTime();
      const age = Date.now() - takenAt;
      const writtenSince = !!entry?.airtableBaseId && lastWriteAt(entry.airtableBaseId) > takenAt;
      if (age >= 0 && age < NAV_SNAPSHOT_TTL_MS && !writtenSince) return toCounts(snap);
    }
  }

  // 2) Stale/absent: recompute from the org's base (status filters pushed into
  // filterByFormula; missing optional tables count 0) and write through so the
  // picker and every subsequent page render share it.
  const highlights = await loadOrgHighlights(ctx);
  if (controlEnabled()) {
    try {
      await saveMetricsSnapshot(ctx.orgSlug, { ...highlights, at: new Date().toISOString() });
    } catch {
      /* the snapshot is an optimisation; never fail the render on a cache write */
    }
  }
  return toCounts({ ...highlights, at: "" });
}

async function fromPostgres(ctx: OrgCtx, f: Record<string, boolean>): Promise<NavCounts> {
  const [jobs, pending, openActions, openRisks, openVariations] = await Promise.all([
    db(ctx).platJob.count({ where: { orgId: ctx.orgId } }),
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

/** Sidebar badge counts from whichever backend is active. These render in the
 *  org layout on every page, so a read failure (e.g. a base missing a table)
 *  must NOT crash the whole shell — degrade to zeros so admin/diagnostic pages
 *  stay reachable to fix the underlying problem. */
export async function loadNavCounts(ctx: OrgCtx): Promise<NavCounts> {
  try {
    // RLS: the shared per-org snapshot is whole-tenant, so it's only valid for a
    // whole-tenant viewer (exempt role, or scoping not enforced). A scoped viewer
    // gets counts filtered to their jobs, computed fresh (no snapshot write).
    const scope = await currentJobScope(ctx);
    if (scope.mode !== "all") {
      return toCounts({ ...(await loadOrgHighlights(ctx, scope)), at: "" });
    }
    return await (airtableEnabled(ctx)
      ? fromAirtable(ctx)
      : fromPostgres(ctx, ctx.config.features));
  } catch (err) {
    logger.warn("Nav counts unavailable — degrading to zeros", {
      org: ctx.orgSlug,
      ...errMeta(err),
    });
    return ZERO_COUNTS;
  }
}
