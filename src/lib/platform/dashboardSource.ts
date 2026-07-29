// Org dashboard data — Postgres (default) or Airtable when the flag is on.
// The landing page after the org picker, so it must run Postgres-free. Reuses
// loadJobsList (jobs + derived completion) and getActiveRules; the rest is
// counted/aggregated from the org's base, including pending proposals from
// PENDING_WRITES in Airtable mode.

import { airtableEnabled, core } from "@/lib/airtable";
import { prisma } from "@/lib/db";
import { getActiveRules } from "@/services/platform/learning";
import { toNum } from "@/lib/format";
import { resolveActionStatus } from "./actionStatus";
import { loadActionStatusMap } from "./configSource";
import { computeJobRag } from "./jobRag";
import { loadJobsList } from "./jobsListSource";
import { PROPOSED_PENDING_FORMULA } from "./pendingWritesSource";
import { budgetActuals, loadProcurement } from "./procurementSource";
import { currentJobScope, inScope } from "./rls";
import type { OrgCtx } from "./types";

/** First linked-record id of an Airtable link cell, or null. */
function firstLink(v: unknown): string | null {
  return Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
}

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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

async function fromAirtable(ctx: OrgCtx): Promise<DashboardView> {
  const [jobList, rules, actionRows, budgetRows, cashflowRows, logRows, pendingRows, procRows, statusMap] = await Promise.all([
    loadJobsList(ctx),
    getActiveRules(ctx),
    core.list(ctx.orgSlug, "ISSUES", { maxRecords: 1000 }),
    core.list(ctx.orgSlug, "BUDGET", { maxRecords: 1000 }),
    core.list(ctx.orgSlug, "CASHFLOWS", { maxRecords: 1000 }),
    // Only 8 log rows render; one page is plenty and avoids a pagination call.
    core.list(ctx.orgSlug, "EXECUTION_LOG", { maxRecords: 100 }),
    // Proposed-only, filtered server-side — the same opts as loadOrgHighlights'
    // read, so a dashboard render shares one cached request with the nav badges.
    core.list(ctx.orgSlug, "PENDING_WRITES", { maxRecords: 1000, filterByFormula: PROPOSED_PENDING_FORMULA }),
    loadProcurement(ctx),
    loadActionStatusMap(ctx),
  ]);
  const actualsByBudget = budgetActuals(procRows); // BUDGET rec id → computed Actual (proc already scoped)

  // RLS: filter every job-scoped read to the viewer's assigned jobs before any
  // tile/total is computed, so the dashboard reflects only their projects.
  const scope = await currentJobScope(ctx);
  const jobs = jobList.filter((j) => inScope(scope, j.id));
  const actions = actionRows.filter((a) => inScope(scope, firstLink(a["Job"])));
  const budgets = budgetRows.filter((b) => inScope(scope, firstLink(b["Job"])));
  const cashflows = cashflowRows.filter((c) => inScope(scope, firstLink(c["Job"])));
  const pendings = pendingRows.filter((p) => inScope(scope, str(p["Job_Id"]) || null));

  // Same status definition as the Action Hub (actionsSource): only cleanly-
  // resolved Open/In Progress rows count; unrecognised values aren't guessed in.
  const now = Date.now();
  const openActionRows = actions.filter((a) => {
    const res = resolveActionStatus(str(a["Status"]), statusMap);
    return res.clean && (res.canonical === "open" || res.canonical === "in_progress");
  });
  const overdueActions = openActionRows.filter((a) => {
    const d = str(a["Due_Date"]);
    return d && new Date(d).getTime() < now;
  }).length;

  // Open Blocker-type issues per job (Spec 12 Module 5 §7): they escalate the
  // derived engagement RAG — reusing the ISSUES rows already loaded above.
  const blockersByJob = new Map<string, number>();
  const openIssuesByJob = new Map<string, number>();
  for (const a of openActionRows) {
    const jobId = firstLink(a["Job"]);
    if (!jobId) continue;
    openIssuesByJob.set(jobId, (openIssuesByJob.get(jobId) ?? 0) + 1);
    if (str(a["Issue_Type"]) === "Blocker") {
      blockersByJob.set(jobId, (blockersByJob.get(jobId) ?? 0) + 1);
    }
  }

  // Portfolio View (Spec 12 M8): budget variance per engagement — estimated vs
  // derived actuals, grouped on the BUDGET rows already loaded above.
  const budgetByJob = new Map<string, { est: number; act: number }>();
  for (const b of budgets) {
    const jobId = firstLink(b["Job"]);
    if (!jobId) continue;
    const agg = budgetByJob.get(jobId) ?? { est: 0, act: 0 };
    agg.est += num(b["Estimated"]);
    agg.act += actualsByBudget.get(b.id) ?? 0;
    budgetByJob.set(jobId, agg);
  }
  const varianceOf = (jobId: string): number | null => {
    const agg = budgetByJob.get(jobId);
    if (!agg || agg.est === 0) return null;
    return Math.round(((agg.act - agg.est) / agg.est) * 1000) / 10;
  };

  // Spec 12 CASHFLOWS is a per-transaction ledger; derive the period
  // projected-vs-actual chart from it — Paid rows are actual, the rest
  // projected. Amounts are signed by direction (Out subtracts) so the chart
  // shows net cash position — same convention as the cashflow window (the
  // 2026-07-20 "cashflow net math" Critical; this branch had been missed).
  const byPeriod = new Map<string, { projected: number; actual: number }>();
  for (const c of cashflows) {
    const period = str(c["Period"]);
    if (!period) continue;
    const agg = byPeriod.get(period) ?? { projected: 0, actual: 0 };
    const signed = str(c["Type"]) === "Out" ? -num(c["Amount"]) : num(c["Amount"]);
    if (str(c["Status"]) === "Paid") agg.actual += signed;
    else agg.projected += signed;
    byPeriod.set(period, agg);
  }

  return {
    jobs: jobs.slice(0, 6).map((j) => ({
      id: j.id,
      name: j.name,
      code: j.code,
      engagementType: j.engagementType,
      completionPct: j.completionPct,
      status: j.status,
      rag: computeJobRag(j.phaseRags, blockersByJob.get(j.id) ?? 0),
      openIssues: openIssuesByJob.get(j.id) ?? 0,
      budgetVariancePct: varianceOf(j.id),
    })),
    openActions: openActionRows.length,
    overdueActions,
    pendingProposals: pendings.length,
    budget: budgets.reduce((s, b) => s + num(b["Estimated"]), 0),
    actual: budgets.reduce((s, b) => s + (actualsByBudget.get(b.id) ?? 0), 0),
    recentLogs: logRows.slice(0, 8).map((l) => ({
      id: l.id,
      operation: str(l["Action_Type"]),
      targetTable: str(l["Tables_Affected"]),
      actorType: str(l["Initiated_By"]),
      actorName: "",
      status: str(l["Status"]) || "executed",
    })),
    activeRules: rules.length,
    cashflow: [...byPeriod.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, v]) => ({ period, projected: v.projected, actual: v.actual })),
  };
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
      prisma.platJob.findMany({ where: { orgId: ctx.orgId, ...ownW }, orderBy: { updatedAt: "desc" }, take: 6 }),
      prisma.platActionHub.count({ where: { orgId: ctx.orgId, status: { in: ["open", "in_progress"] }, ...jobW } }),
      prisma.platActionHub.count({
        where: { orgId: ctx.orgId, status: { in: ["open", "in_progress"] }, dueDate: { lt: new Date() }, ...jobW },
      }),
      prisma.platPendingWrite.count({ where: { orgId: ctx.orgId, status: "proposed", ...jobW } }),
      prisma.platConBudgetLine.aggregate({
        where: { orgId: ctx.orgId, ...jobW },
        _sum: { budgetAmount: true, actualAmount: true },
      }),
      prisma.platExecutionLog.findMany({ where: { orgId: ctx.orgId }, orderBy: { createdAt: "desc" }, take: 8 }),
      prisma.platLearningRule.count({ where: { orgId: ctx.orgId, isActive: true } }),
    ]);

  // Spec 12 ledger (PlatConCashflowLedger, migration-plan Phase 2): Paid rows
  // are actual, the rest projected; amounts signed by direction (Out
  // subtracts) so the chart shows net cash position, matching the cashflow
  // window and the Airtable branch above.
  const cashflows = await prisma.platConCashflowLedger.findMany({
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
      rag: "", // Postgres phases carry no RAG (Airtable is system of record)
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
  return airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx);
}
