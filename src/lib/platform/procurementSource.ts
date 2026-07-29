// Procurement data source — Postgres (default) or the Airtable PROCUREMENT
// table when AIRTABLE_MIGRATION is enabled. Status values match the app's;
// writes use the client's typecast so any missing select option is created.
//
// Spec 12 PROCUREMENT: Procurement_Name · Quantity · Unit_Cost · Supplier(link)
// · Budget_Category(link) · Status · Job. Total_Cost is a formula in Airtable
// (Quantity × Unit_Cost); we compute it app-side. budgetActuals() derives the
// BUDGET.Actual rollup app-side (sum of linked procurement where invoiced/paid).

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { loadJobLabelMap } from "./jobOptionsSource";
import { recordInScope, scopeByJob } from "./rls";
import { mulMoney, sumMoney } from "./money";
import { dateInput, type EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface ProcurementView {
  id: string;
  item: string;
  jobCode: string | null;
  jobId: string | null;
  vendorName: string;
  qty: number;
  total: number;
  /** Expected delivery date (Spec 12 Expected_Date). Kept as `dueDate` for
   *  back-compat with existing list/filter code. */
  dueDate: Date | string | null;
  /** Actual delivery date (Spec 12 Actual_Date); null until delivered. */
  actualDate: Date | string | null;
  /** Delivery delta in whole days: Actual − Expected once delivered, else
   *  today − Expected for a still-open order. Positive = late. null when the
   *  expected date is unknown. */
  deltaDays: number | null;
  /** True when the order is behind its expected date and not yet closed out. */
  isLate: boolean;
  status: string;
  /** Airtable rec id of the linked BUDGET row (Airtable mode only), for
   *  computing BUDGET.Actual app-side; null in Postgres mode / when unlinked. */
  budgetCategoryId: string | null;
}

/** PROCUREMENT statuses that count toward BUDGET.Actual (Spec 12: Invoiced/Paid). */
const ACTUAL_STATUSES = new Set(["invoiced", "paid"]);

/** Statuses at which delivery is complete — no longer "running late". */
const DELIVERED_STATUSES = new Set(["delivered", "invoiced", "paid"]);
const MS_PER_DAY = 86_400_000;

function toDate(v: Date | string | null): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Expected-vs-Actual delivery delta for one order (Spec 12 Module 8 Procurement
 * Tracker). `now` is injectable for deterministic tests. Returns whole-day
 * delta (positive = late) and whether the order is currently overdue.
 */
export function procurementLateness(
  expected: Date | string | null,
  actual: Date | string | null,
  status: string,
  now: Date = new Date(),
): { deltaDays: number | null; isLate: boolean } {
  const exp = toDate(expected);
  if (!exp) return { deltaDays: null, isLate: false };
  const act = toDate(actual);
  const delivered = DELIVERED_STATUSES.has(status.toLowerCase());
  if (act) {
    const deltaDays = Math.round((act.getTime() - exp.getTime()) / MS_PER_DAY);
    return { deltaDays, isLate: deltaDays > 0 };
  }
  if (delivered) return { deltaDays: null, isLate: false };
  const deltaDays = Math.round((now.getTime() - exp.getTime()) / MS_PER_DAY);
  return { deltaDays, isLate: deltaDays > 0 };
}

/**
 * Compute BUDGET.Actual per budget row app-side (the Airtable rollup we can't
 * create via API). Returns a map of BUDGET rec id → summed Total_Cost of its
 * linked PROCUREMENT rows whose Status is Invoiced or Paid.
 */
export function budgetActuals(rows: ProcurementView[]): Map<string, number> {
  const byBudget = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.budgetCategoryId || !ACTUAL_STATUSES.has(r.status.toLowerCase())) continue;
    (byBudget.get(r.budgetCategoryId) ?? byBudget.set(r.budgetCategoryId, []).get(r.budgetCategoryId)!).push(r.total);
  }
  const out = new Map<string, number>();
  for (const [id, amounts] of byBudget) out.set(id, sumMoney(amounts));
  return out;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function firstLink(v: unknown): string | null {
  return Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
}

async function fromPostgres(ctx: OrgCtx): Promise<ProcurementView[]> {
  const rows = await db(ctx).platConProcurement.findMany({
    where: { orgId: ctx.orgId },
    orderBy: [{ status: "asc" }, { dueDate: "asc" }],
    include: { job: { select: { code: true } }, vendor: { select: { name: true } } },
  });
  return rows.map((o) => {
    const { deltaDays, isLate } = procurementLateness(o.dueDate, null, o.status);
    return {
      id: String(o.id),
      item: o.item,
      jobCode: o.job?.code ?? null,
      jobId: o.jobId != null ? String(o.jobId) : null,
      vendorName: o.vendor?.name || o.vendorName,
      qty: o.qty,
      total: toNum(o.total),
      dueDate: o.dueDate,
      actualDate: null, // Postgres model has no actual-delivery column
      deltaDays,
      isLate,
      status: o.status,
      budgetCategoryId: null,
    };
  });
}

async function fromAirtable(ctx: OrgCtx): Promise<ProcurementView[]> {
  const [rows, jobLabels] = await Promise.all([
    core.list(ctx.orgSlug, "PROCUREMENT", { maxRecords: 200 }),
    loadJobLabelMap(ctx),
  ]);
  return rows.map((r) => {
    const qty = num(r["Quantity"]);
    const expected = str(r["Expected_Date"]) || null;
    const actual = str(r["Actual_Date"]) || null;
    const status = str(r["Status"]) || "Ordered";
    const { deltaDays, isLate } = procurementLateness(expected, actual, status);
    const jobRec = firstLink(r["Job"]);
    return {
      id: r.id,
      item: str(r["Procurement_Name"]) || "(untitled item)",
      jobCode: jobRec ? (jobLabels.get(jobRec) ?? null) : null,
      jobId: jobRec,
      // Supplier is a link to ORGANISATIONS, not a text field — left blank here
      // (resolving the link to a name is out of scope for this pass).
      vendorName: "",
      qty,
      total: mulMoney(qty, num(r["Unit_Cost"])), // Total_Cost formula, computed app-side
      dueDate: expected,
      actualDate: actual,
      deltaDays,
      isLate,
      status,
      budgetCategoryId: firstLink(r["Budget_Category"]),
    };
  });
}

/** Load procurement orders from whichever backend is active. */
export async function loadProcurement(ctx: OrgCtx): Promise<ProcurementView[]> {
  const rows = await (airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx));
  return scopeByJob(ctx, rows, (o) => o.jobId);
}

/** Form-ready values for a single order's edit page. Status is lower-cased to
 *  match the app's select vocabulary (a migrated base may store "Ordered").
 *  Fields are limited to what the Airtable field map persists (Supplier /
 *  Budget_Category links and the Total_Cost formula are not editable here). */
export async function loadProcurementDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  if (airtableEnabled(ctx)) {
    let r: Record<string, unknown> | null = null;
    try {
      r = await core.get(ctx.orgSlug, "PROCUREMENT", id);
    } catch {
      return null;
    }
    if (!r) return null;
    if (!(await recordInScope(ctx, r))) return null;
    return {
      item: str(r["Procurement_Name"]),
      qty: num(r["Quantity"]) || 1,
      unitPrice: num(r["Unit_Cost"]),
      status: (str(r["Status"]) || "pending").toLowerCase(),
      dueDate: dateInput(str(r["Expected_Date"]) || null),
    };
  }
  const o = await db(ctx).platConProcurement.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!o) return null;
  if (!(await recordInScope(ctx, o))) return null;
  return {
    item: o.item,
    qty: o.qty,
    unitPrice: toNum(o.unitPrice),
    status: (o.status || "pending").toLowerCase(),
    dueDate: dateInput(o.dueDate),
  };
}
