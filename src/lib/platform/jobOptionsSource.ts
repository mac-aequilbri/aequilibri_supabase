// Job-picker options — Postgres. The shared source behind every job <select>
// on the create/generate pages. Each option's id MUST be the id the write path
// expects: a numeric PK. Posting that id back lets the recordWriter link the
// new record to its job.

import { db, prisma } from "@/lib/db";
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
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  return jobs.map((j) => ({ id: String(j.id), label: `${j.code} — ${j.name}` }));
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
