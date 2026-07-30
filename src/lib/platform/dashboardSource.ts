// Org dashboard data — Postgres. The landing page after the org picker.

import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { currentJobScope } from "./rls";
import type { OrgCtx } from "./types";

export interface DashJob {
  id: string;
  name: string;
  code: string;
  engagementType: string;
  completionPct: number;
  status: string;
  /** Derived engagement RAG (Spec 12 Module 5 §7) — worst-of-phases escalated
   *  by open Blocker issues (jobRag.ts); "" = no signal, render nothing. */
  rag: string;
  /** Portfolio View columns (Spec 12 Module 8, lock plan §8.3) — rendered only
   *  when ENGAGEMENT_TYPE_CONFIG activates the portfolio (decision D-11). */
  openIssues: number;
  /** Budget variance % per engagement (actual vs estimated); null = no signal. */
  budgetVariancePct: number | null;
}
export interface DashLog {
  id: string;
  operation: string;
  targetTable: string;
  actorType: string;
  actorName: string;
  status: string;
}
export interface DashCashflow {
  period: string;
  projected: number;
  actual: number;
}
export interface DashboardView {
  jobs: DashJob[];
  openActions: number;
  overdueActions: number;
  pendingProposals: number;
  budget: number;
  actual: number;
  recentLogs: DashLog[];
  activeRules: number;
  cashflow: DashCashflow[];
}

async function fromPostgres(ctx: OrgCtx): Promise<DashboardView> {
  // RLS: constrain the job-scoped queries to the viewer's assigned jobs. Postgres
  // orgs currently resolve to "all" (no PG assignment store), so this is a no-op
  // there today, but it closes the latent gap if PG parity is added.
  const scope = await currentJobScope(ctx);
  const ids = scope.mode === "some" ? [...scope.jobIds].map(Number).filter((n) => Number.isFinite(n)) : null;
  const jobW = ids ? { jobId: { in: ids } } : scope.mode === "none" ? { jobId: -1 } : {};
  const ownW = ids ? { id: { in: ids } } : scope.mode === "none" ? { id: -1 } : {};
  const [jobs, openActions, overdueActions, pendingProposals, budgetAgg, recentLogs, activeRules] =
    await Promise.all([
      db(ctx).platJob.findMany({ where: { orgId: ctx.orgId, ...ownW }, orderBy: { updatedAt: "desc" }, take: 6 }),
      db(ctx).platActionHub.count({ where: { orgId: ctx.orgId, status: { in: ["open", "in_progress"] }, ...jobW } }),
      db(ctx).platActionHub.count({
        where: { orgId: ctx.orgId, status: { in: ["open", "in_progress"] }, dueDate: { lt: new Date() }, ...jobW },
      }),
      db(ctx).platPendingWrite.count({ where: { orgId: ctx.orgId, status: "proposed", ...jobW } }),
      db(ctx).platConBudgetLine.aggregate({
        where: { orgId: ctx.orgId, ...jobW },
        _sum: { budgetAmount: true, actualAmount: true },
      }),
      db(ctx).platExecutionLog.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: "desc" }, take: 8 }),
      db(ctx).platLearningRule.count({ where: { orgId: ctx.orgId, isActive: true } }),
    ]);

  // Spec 12 ledger (PlatConCashflowLedger, migration-plan Phase 2): Paid rows
  // are actual, the rest projected; amounts signed by direction (Out
  // subtracts) so the chart shows net cash position, matching the cashflow
  // window.
  const cashflows = await db(ctx).platConCashflowLedger.findMany({
    where: { orgId: ctx.orgId, ...jobW },
    select: { period: true, type: true, amount: true, status: true },
  });
  const byPeriod = new Map<string, { projected: number; actual: number }>();
  for (const c of cashflows) {
    const agg = byPeriod.get(c.period) ?? { projected: 0, actual: 0 };
    const signed = c.type === "Out" ? -toNum(c.amount) : toNum(c.amount);
    if (c.status === "Paid") agg.actual += signed;
    else agg.projected += signed;
    byPeriod.set(c.period, agg);
  }

  return {
    jobs: jobs.map((j) => ({
      id: String(j.id),
      name: j.name,
      code: j.code,
      engagementType: j.engagementType,
      completionPct: j.completionPct,
      status: j.status,
      rag: "", // Postgres phases carry no RAG columns
      openIssues: 0,
      budgetVariancePct: null,
    })),
    openActions,
    overdueActions,
    pendingProposals,
    budget: toNum(budgetAgg._sum.budgetAmount ?? 0),
    actual: toNum(budgetAgg._sum.actualAmount ?? 0),
    recentLogs: recentLogs.map((l) => ({
      id: String(l.id),
      operation: l.operation,
      targetTable: l.targetTable,
      actorType: l.actorType,
      actorName: l.actorName,
      status: l.status,
    })),
    activeRules,
    cashflow: [...byPeriod.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, v]) => ({ period, projected: v.projected, actual: v.actual })),
  };
}

export function loadDashboard(ctx: OrgCtx): Promise<DashboardView> {
  return fromPostgres(ctx);
}
