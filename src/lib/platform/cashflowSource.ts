// Cashflow data source — Postgres. Grouped per job.
//
// Spec 12 CASHFLOWS is a per-transaction ledger: Cashflow_Name · Period ·
// Type(In/Out) · Amount · Source_Or_Payee · Category · Status · Job · Notes.
// Reads PlatConCashflowLedger (migration-plan Phase 2), the same
// per-transaction shape. The legacy monthly PlatConCashflow model is no longer
// read anywhere — kept only as pre-ledger historical data.

import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
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

/** Load cashflow grouped by job — RLS-scoped to the viewer's assigned jobs
 *  (each entry is one job). */
export async function loadCashflowJobs(ctx: OrgCtx): Promise<JobCashflow[]> {
  const jobs = await fromPostgres(ctx);
  return scopeByJob(ctx, jobs, (j) => j.id);
}

/** Form-ready values for a single cashflow entry's edit page (Postgres ledger
 *  numeric ids). */
export async function loadCashflowDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
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
