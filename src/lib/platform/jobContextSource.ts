// Job context for AI generation — Postgres. The construction AI services
// (variation drafting, weekly reports, quote-from-budget) build a prompt
// context from a job and its related rows through this one shape. Money values
// are display copies; authoritative math stays in app code (see money.ts).

import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import type { RecordId } from "./recordWriter";
import type { OrgCtx } from "./types";

export interface JobContextPhase {
  name: string;
  status: string;
  completionPct: number;
}
export interface JobContextBudget {
  category: string;
  description: string;
  budgetAmount: number;
  committedAmount: number;
  actualAmount: number;
}
export interface JobContextRisk {
  description: string;
  likelihood: number;
  impact: number;
}
export interface JobContextCashflow {
  period: string;
  projected: number;
  actual: number;
}
export interface JobContextAction {
  title: string;
  owner: string;
  dueDate: Date | null;
}
export interface JobContextVariation {
  refNumber: string;
  title: string;
  costImpact: number;
  status: string;
}

export interface JobContext {
  id: string;
  name: string;
  budgetTotal: number;
  completionPct: number;
  healthScore: number;
  clientName: string;
  phases: JobContextPhase[];
  budget: JobContextBudget[];
  risks: JobContextRisk[];
  cashflow: JobContextCashflow[];
  actions: JobContextAction[];
  variations: JobContextVariation[];
}

async function fromPostgres(ctx: OrgCtx, jobId: RecordId): Promise<JobContext | null> {
  const numId = Number(jobId);
  if (!Number.isInteger(numId)) return null;
  const job = await db(ctx).platJob.findFirst({
    where: { id: numId, orgId: ctx.orgId },
    include: {
      conPhases: { where: { isAiDraft: false }, orderBy: { sortOrder: "asc" } },
      conRisks: { where: { status: "open" } },
      conBudgets: { orderBy: { category: "asc" } },
      conCashflowLedger: { orderBy: { period: "desc" }, take: 200 },
      actions: { where: { status: { in: ["open", "in_progress"] } }, take: 10 },
      conVariations: { where: { status: { in: ["submitted", "approved"] } }, take: 5 },
      clientContact: { select: { name: true } },
    },
  });
  if (!job) return null;
  return {
    id: String(job.id),
    name: job.name,
    budgetTotal: toNum(job.budgetTotal),
    completionPct: job.completionPct,
    healthScore: job.healthScore,
    clientName: job.clientContact?.name ?? "",
    phases: job.conPhases.map((p) => ({ name: p.name, status: p.status, completionPct: p.completionPct })),
    budget: job.conBudgets.map((b) => ({
      category: b.category,
      description: b.description,
      budgetAmount: toNum(b.budgetAmount),
      committedAmount: toNum(b.committedAmount),
      actualAmount: toNum(b.actualAmount),
    })),
    risks: job.conRisks.map((r) => ({ description: r.description, likelihood: r.likelihood, impact: r.impact })),
    // Ledger txns rolled up per period (Paid = actual, else projected; Out
    // subtracts — net position), latest 3 periods.
    cashflow: (() => {
      const byPeriod = new Map<string, { projected: number; actual: number }>();
      for (const c of job.conCashflowLedger) {
        const agg = byPeriod.get(c.period) ?? { projected: 0, actual: 0 };
        const signed = c.type === "Out" ? -toNum(c.amount) : toNum(c.amount);
        if (c.status === "Paid") agg.actual += signed;
        else agg.projected += signed;
        byPeriod.set(c.period, agg);
      }
      return [...byPeriod.entries()]
        .sort(([a], [b]) => b.localeCompare(a))
        .slice(0, 3)
        .map(([period, v]) => ({ period, projected: v.projected, actual: v.actual }));
    })(),
    actions: job.actions.map((a) => ({ title: a.title, owner: a.owner, dueDate: a.dueDate })),
    variations: job.conVariations.map((v) => ({
      refNumber: v.refNumber,
      title: v.title,
      costImpact: toNum(v.costImpact),
      status: v.status,
    })),
  };
}

/** Load a job's AI-generation context. RLS: a scoped viewer can't pull context
 *  for a job they're not assigned to — this guards every AI generator
 *  (reports, variations, quotes, delay) that reads a job through here. */
export async function loadJobContext(ctx: OrgCtx, jobId: RecordId): Promise<JobContext | null> {
  const { currentJobScope, inScope } = await import("./rls");
  if (!inScope(await currentJobScope(ctx), String(jobId))) return null;
  return fromPostgres(ctx, jobId);
}
