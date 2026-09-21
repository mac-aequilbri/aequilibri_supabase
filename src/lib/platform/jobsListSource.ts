// Projects (jobs) LIST data source — Postgres. Backs /app/[org]/projects. The
// list MUST emit the same id the detail page (jobDetailSource) resolves: a
// numeric PK.

import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { excludeGeneral } from "./generalJob";
import { resolveJobScope, scopeRows } from "./rls";
import type { OrgCtx } from "./types";

export interface JobListView {
  id: string;
  name: string;
  code: string;
  engagementType: string;
  address: string;
  suburb: string;
  status: string;
  completionPct: number;
  healthScore: number;
  budgetTotal: number;
  /** Derived engagement RAG from the job's phases (jobRag.ts); "" = no signal.
   *  Consumers with an ISSUES read (dashboard) recompute with blocker counts. */
  rag: string;
  /** The phase RAG cells behind `rag`, so consumers can re-aggregate with more
   *  context (open Blockers) without another PHASES read. */
  phaseRags: string[];
  counts: { phases: number; actions: number; risks: number };
}

async function fromPostgres(ctx: OrgCtx): Promise<JobListView[]> {
  const jobs = await db(ctx).platJob.findMany({
    // The Organisation-wide bucket is not a project — it never appears here.
    where: { orgId: ctx.orgId, ...excludeGeneral(ctx) },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { conPhases: true, actions: true, conRisks: true } } },
  });
  return jobs.map((job) => ({
    id: String(job.id),
    name: job.name,
    code: job.code,
    engagementType: job.engagementType,
    address: job.address ?? "",
    suburb: job.suburb ?? "",
    status: job.status,
    completionPct: job.completionPct,
    healthScore: job.healthScore,
    budgetTotal: toNum(job.budgetTotal),
    rag: "", // Postgres phases carry no RAG columns
    phaseRags: [],
    counts: {
      phases: job._count.conPhases,
      actions: job._count.actions,
      risks: job._count.conRisks,
    },
  }));
}

/** Load the projects list. Pass the viewer to apply RLS (governance §3):
 *  non-exempt roles see only the JOBS their TEAM record links to — unscoped
 *  until TEAM assignments exist (see rls.ts). */
export async function loadJobsList(
  ctx: OrgCtx,
  viewer?: { email: string; role: string },
): Promise<JobListView[]> {
  const jobs = await fromPostgres(ctx);
  if (!viewer) return jobs;
  // Canonical scope: exempt → all; otherwise assigned jobs ∪ the org's General
  // project, honouring the fail-open/closed enforce gate (see resolveJobScope).
  return scopeRows(jobs, (j) => j.id, await resolveJobScope(ctx, viewer));
}
