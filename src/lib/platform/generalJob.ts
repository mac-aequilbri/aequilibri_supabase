// The org's "Organisation-wide" bucket — the shared home for records that
// belong to the organisation rather than to any one project
// (docs/archive/project-general-bucket-plan.md).
//
// It is stored as a PlatJob row for two reasons only: every operational record
// must point at a real job id (no null-job leak vector), and RLS needs a real
// id to hold in scope for every member. That storage decision must NOT leak
// into the UI — the bucket is a PLACE, not a project, and must never be listed,
// counted, or rendered alongside real projects. An org with one project and a
// bucket has ONE project.
//
// Identified two ways, because orgs provisioned before the type column existed
// carry only the registry pointer: `engagementType = "general"` on the row, or
// the id in registry Settings.generalJobId (ctx.config.generalJobId).
//
// Surfaces that must exclude it: the projects list (jobsListSource), the nav
// badge and multi-job switch (navCountsSource → nav.ts), the org metrics
// snapshot (orgHighlightsSource), and the dashboard's recent projects
// (dashboardSource). Job PICKERS keep it — filing an org-level record is a real
// choice — but label it GENERAL_LABEL and pin it, never "CODE — Name".

import type { OrgCtx } from "./types";

/** Marks the bucket on the Postgres backend (EngagementType union member). */
export const GENERAL_ENGAGEMENT_TYPE = "general";

/** What a user sees. Deliberately not project-shaped, so it never reads as one. */
export const GENERAL_LABEL = "Organisation-wide";

/** The configured bucket id as a number — registry Settings.generalJobId is a
 *  string, while PlatJob.id is an Int. Null when the org has no pointer yet. */
export function generalJobId(ctx: OrgCtx): number | null {
  const raw = ctx.config?.generalJobId;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** True when a loaded job row is the bucket. */
export function isGeneralJob(
  ctx: OrgCtx,
  job: { id: number | string; engagementType?: string | null },
): boolean {
  if (job.engagementType === GENERAL_ENGAGEMENT_TYPE) return true;
  const configured = generalJobId(ctx);
  return configured !== null && Number(job.id) === configured;
}

/** Prisma `where` fragment that drops the bucket from project-shaped reads.
 *  Spread into an existing where: `{ orgId: ctx.orgId, ...excludeGeneral(ctx) }`. */
export function excludeGeneral(ctx: OrgCtx) {
  const configured = generalJobId(ctx);
  const clauses: Array<Record<string, unknown>> = [
    { engagementType: GENERAL_ENGAGEMENT_TYPE },
  ];
  if (configured !== null) clauses.push({ id: configured });
  return { NOT: { OR: clauses } };
}
