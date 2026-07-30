// Budget data source — Postgres. Grouped per job.
//
// Spec 12 BUDGET: Budget_Category · Estimated · Actual(rollup) · Forecast ·
// Variance · RAG · Phase · Job.

import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { recordInScope, scopeByJob } from "./rls";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface BudgetLineView {
  id: string;
  category: string;
  description: string;
  budgetAmount: number; // Estimated
  committedAmount: number;
  actualAmount: number;
  forecast: number;
  variance: number; // Forecast − Estimated
  rag: string;
  phaseName: string;
}

export interface JobBudget {
  id: string;
  name: string;
  code: string;
  conBudgets: BudgetLineView[];
}

async function fromPostgres(ctx: OrgCtx): Promise<JobBudget[]> {
  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { code: "asc" },
    include: {
      conBudgets: { orderBy: [{ category: "asc" }], include: { phase: { select: { name: true } } } },
    },
  });
  return jobs.map((j) => ({
    id: String(j.id),
    name: j.name,
    code: j.code,
    conBudgets: j.conBudgets.map((b) => ({
      id: String(b.id),
      category: b.category,
      description: b.description,
      budgetAmount: toNum(b.budgetAmount),
      committedAmount: toNum(b.committedAmount),
      actualAmount: toNum(b.actualAmount),
      forecast: toNum(b.budgetAmount),
      variance: 0,
      rag: "",
      phaseName: b.phase?.name ?? "",
    })),
  }));
}

/** Load budget grouped by job — RLS-scoped to the viewer's assigned jobs
 *  (each entry is one job). */
export async function loadBudgetJobs(ctx: OrgCtx): Promise<JobBudget[]> {
  const jobs = await fromPostgres(ctx);
  return scopeByJob(ctx, jobs, (j) => j.id);
}

/** Form-ready values for a single budget line's edit page. `actualAmount` is a
 *  derived rollup (from confirmed procurement) — shown read-only. Null if the
 *  line isn't in this org. */
export async function loadBudgetLineDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  const b = await db(ctx).platConBudgetLine.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!b) return null;
  if (!(await recordInScope(ctx, b))) return null;
  return {
    category: b.category,
    description: b.description,
    budgetAmount: toNum(b.budgetAmount),
    forecast: toNum(b.budgetAmount),
    rag: "",
    actualAmount: toNum(b.actualAmount),
  };
}
