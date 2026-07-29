// Budget data source — Postgres (default) or Airtable when the flag is on.
// Grouped per job (BUDGET rows' Job link resolved against JOBS).
//
// Spec 12 BUDGET: Budget_Category · Estimated · Actual(rollup) · Forecast ·
// Variance · RAG · Phase · Job. `Actual` is an Airtable rollup we can't create
// via the API, so in Airtable mode it is computed app-side from linked
// PROCUREMENT (see budgetActuals). Variance is derived as Forecast − Estimated.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { sumMoney } from "./money";
import { budgetActuals, loadProcurement } from "./procurementSource";
import { recordInScope, scopeByJob } from "./rls";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface BudgetLineView {
  id: string;
  category: string;
  description: string;
  budgetAmount: number; // Estimated
  committedAmount: number; // no Spec 12 field — 0 in Airtable mode
  actualAmount: number; // Actual — computed from PROCUREMENT in Airtable mode
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
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

async function fromAirtable(ctx: OrgCtx): Promise<JobBudget[]> {
  const [jobRows, bRows, procRows] = await Promise.all([
    core.list(ctx.orgSlug, "JOBS", { maxRecords: 200 }),
    core.list(ctx.orgSlug, "BUDGET", { maxRecords: 500 }),
    loadProcurement(ctx),
  ]);
  const actuals = budgetActuals(procRows); // BUDGET rec id → computed Actual
  const byJob = new Map<string, BudgetLineView[]>();
  for (const b of bRows) {
    const link = b["Job"];
    const key = Array.isArray(link) && link.length > 0 ? String(link[0]) : "_unassigned";
    const estimated = num(b["Estimated"]);
    const forecast = num(b["Forecast"]);
    const row: BudgetLineView = {
      id: b.id,
      category: str(b["Budget_Category"]),
      description: str(b["Notes"]),
      budgetAmount: estimated,
      committedAmount: 0,
      actualAmount: actuals.get(b.id) ?? 0,
      forecast,
      variance: sumMoney([forecast, -estimated]),
      rag: str(b["RAG"]),
      phaseName: "",
    };
    (byJob.get(key) ?? byJob.set(key, []).get(key)!).push(row);
  }
  for (const rows of byJob.values()) rows.sort((a, b) => a.category.localeCompare(b.category));
  return jobRows.map((j) => ({
    id: j.id,
    name: str(j["Job_Name"]) || "(job)",
    code: "",
    conBudgets: byJob.get(j.id) ?? [],
  }));
}

/** Load budget grouped by job from whichever backend is active — RLS-scoped to
 *  the viewer's assigned jobs (each entry is one job). */
export async function loadBudgetJobs(ctx: OrgCtx): Promise<JobBudget[]> {
  const jobs = await (airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx));
  return scopeByJob(ctx, jobs, (j) => j.id);
}

/** Form-ready values for a single budget line's edit page. `actualAmount` is a
 *  derived rollup (from confirmed procurement) — shown read-only. Null if the
 *  line isn't in this org. */
export async function loadBudgetLineDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  if (airtableEnabled(ctx)) {
    let b: Record<string, unknown> | null = null;
    try {
      b = await core.get(ctx.orgSlug, "BUDGET", id);
    } catch {
      return null;
    }
    if (!b) return null;
    if (!(await recordInScope(ctx, b))) return null;
    const actuals = budgetActuals(await loadProcurement(ctx));
    return {
      category: str(b["Budget_Category"]),
      description: str(b["Notes"]),
      budgetAmount: num(b["Estimated"]),
      forecast: num(b["Forecast"]),
      rag: str(b["RAG"]),
      actualAmount: actuals.get(id) ?? 0,
    };
  }
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
