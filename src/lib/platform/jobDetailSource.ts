// Job detail data source — Postgres. Backs /app/[org]/projects/[id]. The page
// renders a uniform JobDetailView; loadJobDetail returns null when the job is
// absent (page → notFound()). id is a numeric PK.

import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import type { OrgCtx } from "./types";

export interface JobPhaseRow {
  id: string;
  name: string;
  status: string;
  completionPct: number;
  /** Stored phase RAG ("" when unset — the Postgres model has no RAG column). */
  rag: string;
}
export interface JobRiskRow {
  id: string;
  description: string;
  likelihood: number;
  impact: number;
}
export interface JobActionRow {
  id: string;
  title: string;
  owner: string;
  dueDate: Date | null;
}

export interface JobDetailView {
  id: string;
  name: string;
  code: string;
  engagementType: string;
  address: string;
  suburb: string;
  completionPct: number;
  healthScore: number;
  /** Derived engagement RAG (Spec 12 Module 5 §7, jobRag.ts) — worst-of-phases;
   *  "" = no phase carries a RAG signal. */
  rag: string;
  summary: string;
  budget: number;
  actual: number;
  phases: JobPhaseRow[];
  risks: JobRiskRow[];
  actions: JobActionRow[];
  counts: { bimModels: number; documents: number; variations: number };
}

async function fromPostgres(ctx: OrgCtx, id: string): Promise<JobDetailView | null> {
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) return null;
  const job = await db(ctx).platJob.findFirst({
    where: { id: jobId, orgId: ctx.orgId },
    include: {
      conPhases: { where: { isAiDraft: false }, orderBy: { sortOrder: "asc" } },
      conRisks: { where: { status: "open" }, orderBy: { createdAt: "desc" }, take: 5 },
      actions: {
        where: { status: { in: ["open", "in_progress"] } },
        orderBy: { dueDate: "asc" },
        take: 5,
      },
      conBudgets: true,
      _count: { select: { conBimModels: true, documents: true, conVariations: true } },
    },
  });
  if (!job) return null;
  return {
    id: String(job.id),
    name: job.name,
    code: job.code,
    engagementType: job.engagementType,
    address: job.address ?? "",
    suburb: job.suburb ?? "",
    completionPct: job.completionPct,
    healthScore: job.healthScore,
    rag: "", // Postgres phases carry no RAG columns
    summary: job.summary ?? "",
    budget: job.conBudgets.reduce((s, b) => s + toNum(b.budgetAmount), 0),
    actual: job.conBudgets.reduce((s, b) => s + toNum(b.actualAmount), 0),
    phases: job.conPhases.map((p) => ({
      id: String(p.id),
      name: p.name,
      status: p.status,
      completionPct: p.completionPct,
      rag: "",
    })),
    risks: job.conRisks.map((r) => ({
      id: String(r.id),
      description: r.description,
      likelihood: r.likelihood,
      impact: r.impact,
    })),
    actions: job.actions.map((a) => ({
      id: String(a.id),
      title: a.title,
      owner: a.owner,
      dueDate: a.dueDate,
    })),
    counts: {
      bimModels: job._count.conBimModels,
      documents: job._count.documents,
      variations: job._count.conVariations,
    },
  };
}

/** Load a single job's detail view. */
export function loadJobDetail(ctx: OrgCtx, id: string): Promise<JobDetailView | null> {
  return fromPostgres(ctx, id);
}
