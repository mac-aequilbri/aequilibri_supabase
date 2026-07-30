// Phases data source — Postgres. Grouped per job.

import { db, prisma } from "@/lib/db";
import { recordInScope, scopeByJob } from "./rls";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface PhaseView {
  id: string;
  name: string;
  status: string;
  completionPct: number;
  isAiDraft: boolean;
  jobId: string;
  evidenceSuggestion: string;
  _count: { evidence: number };
  // Spec 12 Module 5 phase fields (Phase RAG board). RAG is the stored health
  // signal; "" when unset. phaseType/loopPermitted describe linear-vs-cyclical
  // engagement shape. sequence orders the lifecycle; openIssues counts linked
  // ISSUES. Defaulted on Postgres (no columns for them yet).
  rag: string;
  phaseType: string;
  loopPermitted: boolean;
  sequence: number;
  startDate: string | null;
  endDate: string | null;
  openIssues: number;
}

/** Canonical RAG label from a stored cell (tolerant of case / G-A-R shorthand). */
export function normalizeRag(v: unknown): string {
  const s = (typeof v === "string" ? v : "").trim().toLowerCase();
  if (s.startsWith("r")) return "Red";
  if (s.startsWith("a")) return "Amber";
  if (s.startsWith("g")) return "Green";
  return "";
}

export interface JobPhases {
  id: string;
  name: string;
  code: string;
  conPhases: PhaseView[];
}

async function fromPostgres(ctx: OrgCtx): Promise<JobPhases[]> {
  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { code: "asc" },
    include: {
      conPhases: {
        orderBy: { sortOrder: "asc" },
        include: { _count: { select: { evidence: true } } },
      },
    },
  });
  return jobs.map((j) => ({
    id: String(j.id),
    name: j.name,
    code: j.code,
    conPhases: j.conPhases.map((p) => ({
      id: String(p.id),
      name: p.name,
      status: p.status,
      completionPct: p.completionPct,
      isAiDraft: p.isAiDraft,
      jobId: String(p.jobId),
      evidenceSuggestion: p.evidenceSuggestion,
      _count: { evidence: p._count.evidence },
      // Postgres model has no RAG/type/loop columns; dates come from the
      // model, the rest default.
      rag: "",
      phaseType: "",
      loopPermitted: false,
      sequence: p.sortOrder,
      startDate: p.startDate ? p.startDate.toISOString().slice(0, 10) : null,
      endDate: p.endDate ? p.endDate.toISOString().slice(0, 10) : null,
      openIssues: 0,
    })),
  }));
}

/** Load phases grouped by job — RLS-scoped to the viewer's assigned jobs
 *  (each entry is one job). */
export async function loadPhaseJobs(ctx: OrgCtx): Promise<JobPhases[]> {
  const jobs = await fromPostgres(ctx);
  return scopeByJob(ctx, jobs, (j) => j.id);
}

/** Form-ready values for a single phase's edit page. Null if not in this org.
 *  (Evidence / AI-suggestion workflow stays on the list page.) */
export async function loadPhaseDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  const p = await db(ctx).platConPhase.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!p) return null;
  if (!(await recordInScope(ctx, p))) return null;
  return {
    name: p.name,
    status: p.status,
    completionPct: p.completionPct,
    sortOrder: p.sortOrder,
  };
}
