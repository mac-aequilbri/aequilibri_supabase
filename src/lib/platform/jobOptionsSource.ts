// Job-picker options — Postgres. The shared source behind every job <select>
// on the create/generate pages. Each option's id MUST be the id the write path
// expects: a numeric PK. Posting that id back lets the recordWriter link the
// new record to its job.

import { db, prisma } from "@/lib/db";
import { GENERAL_LABEL, isGeneralJob } from "./generalJob";
import { currentJobScope, inScope } from "./rls";
import type { OrgCtx } from "./types";

export interface JobOption {
  id: string;
  /** Display label: "CODE — Name". */
  label: string;
}

async function fromPostgres(ctx: OrgCtx): Promise<JobOption[]> {
  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId },
    select: { id: true, code: true, name: true, engagementType: true },
    orderBy: { code: "asc" },
  });
  // The Organisation-wide bucket stays selectable — filing an org-level record
  // is a real choice — but it is not a project: it carries its own label rather
  // than "CODE — Name", and is pinned above the projects instead of sorted in
  // among them.
  const options = jobs.map((j) => ({
    id: String(j.id),
    label: isGeneralJob(ctx, j) ? GENERAL_LABEL : `${j.code} — ${j.name}`,
    general: isGeneralJob(ctx, j),
  }));
  return [
    ...options.filter((o) => o.general).map(({ id, label }) => ({ id, label })),
    ...options.filter((o) => !o.general).map(({ id, label }) => ({ id, label })),
  ];
}

/** Load the job-picker options — RLS-scoped to the viewer's assigned jobs
 *  (+ their org's General project). A scoped user can only file records
 *  against, or target, projects they're assigned to. */
export async function loadJobOptions(ctx: OrgCtx): Promise<JobOption[]> {
  const all = await fromPostgres(ctx);
  const scope = await currentJobScope(ctx);
  return scope.mode === "all" ? all : all.filter((o) => inScope(scope, o.id));
}

/** Record id → job display name. Always empty on Postgres — the sources
 *  resolve the job through a Prisma relation include instead. */
export async function loadJobLabelMap(_ctx: OrgCtx): Promise<Map<string, string>> {
  return new Map();
}
