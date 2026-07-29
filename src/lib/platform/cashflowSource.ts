// Cashflow data source — Postgres (default) or Airtable when the flag is on.
// Grouped per job (CASHFLOWS rows' Job link resolved against JOBS).
//
// Spec 12 CASHFLOWS is a per-transaction ledger: Cashflow_Name · Period ·
// Type(In/Out) · Amount · Source_Or_Payee · Category · Status · Job · Notes.
// The Postgres branch reads PlatConCashflowLedger (migration-plan Phase 2),
// the same per-transaction shape. The legacy monthly PlatConCashflow model is
// no longer read anywhere — kept only as pre-ledger historical data.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { comparePeriods, toNum } from "@/lib/format";
import { recordInScope, scopeByJob } from "./rls";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export type CashflowType = "In" | "Out";

export interface CashflowTxn {
  id: string;
  name: string;
  period: string;
  type: CashflowType;
  amount: number;
  sourceOrPayee: string;
  category: string;
  status: string;
  notes: string;
}

export interface JobCashflow {
  id: string;
  name: string;
  code: string;
  conCashflows: CashflowTxn[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function asType(v: unknown): CashflowType {
  return str(v) === "In" ? "In" : "Out";
}

async function fromPostgres(ctx: OrgCtx): Promise<JobCashflow[]> {
  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { code: "asc" },
    include: { conCashflowLedger: { orderBy: { period: "asc" } } },
  });
  return jobs.map((j) => ({
    id: String(j.id),
    name: j.name,
    code: j.code,
    conCashflows: j.conCashflowLedger.map(
      (c): CashflowTxn => ({
        id: String(c.id),
        name: c.name,
        period: c.period,
        type: asType(c.type),
        amount: toNum(c.amount),
        sourceOrPayee: c.sourceOrPayee,
        category: c.category,
        status: c.status || "Forecast",
        notes: c.notes,
      }),
    ),
  }));
}

async function fromAirtable(ctx: OrgCtx): Promise<JobCashflow[]> {
  const [jobRows, cfRows] = await Promise.all([
    core.list(ctx.orgSlug, "JOBS", { maxRecords: 200 }),
    core.list(ctx.orgSlug, "CASHFLOWS", { maxRecords: 500 }),
  ]);
  const byJob = new Map<string, CashflowTxn[]>();
  for (const c of cfRows) {
    const link = c["Job"];
    const key = Array.isArray(link) && link.length > 0 ? String(link[0]) : "_unassigned";
    const row: CashflowTxn = {
      id: c.id,
      name: str(c["Cashflow_Name"]),
      period: str(c["Period"]),
      type: asType(c["Type"]),
      amount: num(c["Amount"]),
      sourceOrPayee: str(c["Source_Or_Payee"]),
      category: str(c["Category"]),
      status: str(c["Status"]) || "Forecast",
      notes: str(c["Notes"]),
    };
    (byJob.get(key) ?? byJob.set(key, []).get(key)!).push(row);
  }
  for (const rows of byJob.values()) rows.sort((a, b) => comparePeriods(a.period, b.period));
  return jobRows.map((j) => ({
    id: j.id,
    name: str(j["Job_Name"]) || "(job)",
    code: "",
    conCashflows: byJob.get(j.id) ?? [],
  }));
}

/** Load cashflow grouped by job from whichever backend is active — RLS-scoped to
 *  the viewer's assigned jobs (each entry is one job). */
export async function loadCashflowJobs(ctx: OrgCtx): Promise<JobCashflow[]> {
  const jobs = await (airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx));
  return scopeByJob(ctx, jobs, (j) => j.id);
}

/** Form-ready values for a single cashflow entry's edit page, from whichever
 *  backend is active (Airtable rec… ids / Postgres ledger numeric ids). */
export async function loadCashflowDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  if (airtableEnabled(ctx)) {
    let c: Record<string, unknown> | null = null;
    try {
      c = await core.get(ctx.orgSlug, "CASHFLOWS", id);
    } catch {
      return null;
    }
    if (!c) return null;
    if (!(await recordInScope(ctx, c))) return null;
    return {
      name: str(c["Cashflow_Name"]),
      period: str(c["Period"]),
      type: asType(c["Type"]),
      amount: num(c["Amount"]),
      sourceOrPayee: str(c["Source_Or_Payee"]),
      category: str(c["Category"]),
      status: str(c["Status"]) || "Forecast",
      notes: str(c["Notes"]),
    };
  }
  const numId = Number(id);
  if (!Number.isInteger(numId)) return null;
  const c = await db(ctx).platConCashflowLedger.findFirst({
    where: { id: numId, orgId: ctx.orgId },
  });
  if (!c) return null;
  if (!(await recordInScope(ctx, c as unknown as Record<string, unknown>))) return null;
  return {
    name: c.name,
    period: c.period,
    type: asType(c.type),
    amount: toNum(c.amount),
    sourceOrPayee: c.sourceOrPayee,
    category: c.category,
    status: c.status || "Forecast",
    notes: c.notes,
  };
}
