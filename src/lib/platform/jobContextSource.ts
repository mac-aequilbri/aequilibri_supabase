// Job context for AI generation — Postgres (default) or Airtable when the flag
// is on. The construction AI services (variation drafting, weekly reports,
// quote-from-budget) build a prompt context from a job and its related rows.
// Before this, those reads went straight to db(ctx).platJob, so generation was
// impossible for an Airtable-only org (no Postgres job to read). This source
// gives them one shape over either backend; the Airtable side filters the
// related tables by their Job link, exactly like jobDetailSource/jobsListSource.
//
// ACTION_HUB has no Job link in Airtable, so `actions` is empty in Airtable
// mode — matching jobDetailSource. Money values are display copies; authoritative
// math stays in app code (see money.ts).

import { airtableEnabled, core } from "@/lib/airtable";
import type { CoreRow } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { VARIATION_FILTER, variationStatusFromAir } from "./changeLog";
import { listOptional } from "./optionalList";
import { budgetActuals, loadProcurement } from "./procurementSource";
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function linksTo(v: unknown, recordId: string): boolean {
  return Array.isArray(v) && v.some((x) => String(x) === recordId);
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
    // subtracts — net position), latest 3 periods, matching the Airtable branch.
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

async function fromAirtable(ctx: OrgCtx, jobId: RecordId): Promise<JobContext | null> {
  const id = String(jobId);
  if (!id.startsWith("rec")) return null;
  let job;
  try {
    job = await core.get(ctx.orgSlug, "JOBS", id);
  } catch {
    return null;
  }

  // RISKS and VARIATIONS are optional Domain-tier tables — a supplied/ drifted
  // base can lack them, and Airtable answers a missing table with a 403 that
  // would otherwise reject this whole batch and crash generation. Read them
  // tolerantly (→ [] when absent); the core tables stay strict.
  // Read only THIS job's children — by their record ids from the job's own link
  // fields — so this stays fast on orgs with thousands of matters (the in-memory
  // linksTo() filters below remain an exact guard). CHANGE_LOG is fetched by the
  // job's linked ids too, then the variation filter is applied in memory.
  const EMPTY = Promise.resolve([] as CoreRow[]);
  const byIds = (v: unknown) => {
    const ids = Array.isArray(v) ? v.map(String).filter((s) => s.startsWith("rec")) : [];
    return ids.length ? { filterByFormula: `OR(${ids.map((id) => `RECORD_ID()='${id}'`).join(",")})` } : null;
  };
  const phaseOpts = byIds(job["PHASES"]);
  const riskOpts = byIds(job["RISKS"]);
  const budgetOpts = byIds(job["BUDGET"]);
  const cashOpts = byIds(job["CASHFLOWS"]);
  const changeIds = byIds(job["CHANGE_LOG"]);
  // Keep the variation-type filter (CHANGE_LOG also holds non-variation rows).
  const changeOpts = changeIds
    ? { filterByFormula: `AND(${VARIATION_FILTER},${changeIds.filterByFormula})` }
    : null;
  const [phaseRows, riskRows, budgetRows, cashflowRows, variationRows, procRows] = await Promise.all([
    phaseOpts ? core.list(ctx.orgSlug, "PHASES", phaseOpts) : EMPTY,
    riskOpts ? listOptional(ctx.orgSlug, "RISKS", riskOpts) : EMPTY,
    budgetOpts ? core.list(ctx.orgSlug, "BUDGET", budgetOpts) : EMPTY,
    cashOpts ? core.list(ctx.orgSlug, "CASHFLOWS", cashOpts) : EMPTY,
    changeOpts ? listOptional(ctx.orgSlug, "CHANGE_LOG", changeOpts) : EMPTY,
    loadProcurement(ctx),
  ]);
  const actualsByBudget = budgetActuals(procRows); // BUDGET rec id → computed Actual

  const phases: JobContextPhase[] = phaseRows
    .filter((p) => linksTo(p["Job"], id) && p["Is_AI_Draft"] !== true)
    .sort((a, b) => num(a["Sort_Order"]) - num(b["Sort_Order"]))
    .map((p) => ({
      name: str(p["Phase_Name"]) || "(phase)",
      status: str(p["Status"]) || "pending",
      completionPct: num(p["Completion_Pct"]),
    }));

  const risks: JobContextRisk[] = riskRows
    .filter((r) => linksTo(r["Job"], id) && (str(r["Status"]) || "open") === "open")
    .map((r) => ({
      description: str(r["Risk"]) || "(risk)",
      likelihood: num(r["Likelihood"]) || 1,
      impact: num(r["Impact"]) || 1,
    }));

  const budget: JobContextBudget[] = budgetRows
    .filter((b) => linksTo(b["Job"], id))
    .map((b) => ({
      category: str(b["Budget_Category"]),
      description: str(b["Notes"]),
      budgetAmount: num(b["Estimated"]),
      committedAmount: 0, // no Spec 12 field
      actualAmount: actualsByBudget.get(b.id) ?? 0, // computed from PROCUREMENT
    }));

  // Spec 12 CASHFLOWS is a per-transaction ledger; roll the job's rows up into
  // a projected-vs-actual-per-period summary for the AI context (Paid =
  // actual; Out subtracts — net position, the cashflow-window convention).
  const cfByPeriod = new Map<string, { projected: number; actual: number }>();
  for (const c of cashflowRows) {
    if (!linksTo(c["Job"], id)) continue;
    const period = str(c["Period"]);
    if (!period) continue;
    const agg = cfByPeriod.get(period) ?? { projected: 0, actual: 0 };
    const signed = str(c["Type"]) === "Out" ? -num(c["Amount"]) : num(c["Amount"]);
    if (str(c["Status"]) === "Paid") agg.actual += signed;
    else agg.projected += signed;
    cfByPeriod.set(period, agg);
  }
  const cashflow: JobContextCashflow[] = [...cfByPeriod.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 3)
    .map(([period, v]) => ({ period, projected: v.projected, actual: v.actual }));

  const variations: JobContextVariation[] = variationRows
    .filter(
      (v) =>
        linksTo(v["Job"], id) &&
        ["submitted", "approved"].includes(variationStatusFromAir(v["Status"])),
    )
    .slice(0, 5)
    .map((v) => ({
      refNumber: str(v["Ref_Number"]),
      title: str(v["Change_Name"]) || "(variation)",
      costImpact: num(v["Impact_Cost"]),
      status: variationStatusFromAir(v["Status"]),
    }));

  return {
    id: job.id,
    name: str(job["Job_Name"]) || "(job)",
    budgetTotal: num(job["Estimated_Value"]),
    completionPct: phases.length
      ? Math.round(phases.reduce((s, p) => s + p.completionPct, 0) / phases.length)
      : 0,
    healthScore: 0, // not tracked in Airtable JOBS
    clientName: "", // no client-contact link surfaced on Airtable JOBS
    phases,
    budget,
    risks,
    cashflow,
    actions: [], // ACTION_HUB has no Job link in Airtable
    variations,
  };
}

/** Load a job's AI-generation context from whichever backend is active. RLS:
 *  a scoped viewer can't pull context for a job they're not assigned to — this
 *  guards every AI generator (reports, variations, quotes, delay) that reads a
 *  job through here. */
export async function loadJobContext(ctx: OrgCtx, jobId: RecordId): Promise<JobContext | null> {
  const { currentJobScope, inScope } = await import("./rls");
  if (!inScope(await currentJobScope(ctx), String(jobId))) return null;
  return airtableEnabled(ctx) ? fromAirtable(ctx, jobId) : fromPostgres(ctx, jobId);
}
