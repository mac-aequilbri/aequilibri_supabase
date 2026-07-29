import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import type { RecordId } from "@/lib/platform/recordWriter";
import { proposalJobId } from "./proposalSource";
import { currentJobScope, inScope } from "./rls";
import type { OrgCtx } from "./types";

export interface PendingWriteView {
  id: RecordId;
  tableKey: string;
  op: string;
  recordId: string;
  /** The proposal's target job (rec id / numeric string), for RLS scoping of
   *  the approval queue. null = org-global. Airtable stores it only in the
   *  payload, so we fall back to that when the Job_Id column is blank. */
  jobId: string | null;
  payload: string;
  actorType: string;
  actorName: string;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  resolvedBy: string;
  resolvedAt: Date | null;
  error: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function date(v: unknown): Date | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function fromPostgres(ctx: OrgCtx): Promise<PendingWriteView[]> {
  const rows = await db(ctx).platPendingWrite.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    tableKey: r.tableKey,
    op: r.op,
    recordId: r.recordId == null ? "" : String(r.recordId),
    jobId: proposalJobId(r.jobId, r.payload),
    payload: r.payload,
    actorType: r.actorType,
    actorName: r.actorName,
    status: r.status,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    resolvedBy: r.resolvedBy,
    resolvedAt: r.resolvedAt,
    error: r.error,
  }));
}

async function fromAirtable(ctx: OrgCtx): Promise<PendingWriteView[]> {
  const rows = await core.list(ctx.orgSlug, "PENDING_WRITES", { maxRecords: 1000 });
  return rows
    .map((r) => ({
      id: r.id,
      tableKey: str(r["Table_Key"]),
      op: str(r["Op"]),
      recordId: str(r["Record_Id"]),
      jobId: proposalJobId(r["Job_Id"], str(r["Payload"])),
      payload: str(r["Payload"]),
      actorType: str(r["Actor_Type"]),
      actorName: str(r["Actor_Name"]),
      status: str(r["Status"]),
      createdAt: date(r["Created_At"]) ?? new Date(0),
      expiresAt: date(r["Expires_At"]) ?? new Date(0),
      resolvedBy: str(r["Resolved_By"]),
      resolvedAt: date(r["Resolved_At"]),
      error: str(r["Error"]),
    }))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

export function loadPendingWrites(ctx: OrgCtx): Promise<PendingWriteView[]> {
  return airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx);
}

/** Server-side filter for the approval queue's "awaiting decision" rows. Every
 *  proposed-count reader (nav badges, dashboard, coordination) must use these
 *  exact list opts so one render shares a single cached request. */
export const PROPOSED_PENDING_FORMULA = `LOWER({Status})='proposed'`;

/** Count of proposed (awaiting-approval) pending writes only — cheaper than
 *  loadPendingWrites when the resolved history isn't needed. */
export async function loadProposedPendingCount(ctx: OrgCtx): Promise<number> {
  // RLS: count only proposals on the viewer's assigned jobs (org-global rows —
  // no job — always count). No-op for whole-tenant viewers.
  const scope = await currentJobScope(ctx);
  if (!airtableEnabled(ctx)) {
    const ids = scope.mode === "some" ? [...scope.jobIds].map(Number).filter((n) => Number.isFinite(n)) : null;
    const jobW = ids ? { jobId: { in: ids } } : scope.mode === "none" ? { jobId: -1 } : {};
    return db(ctx).platPendingWrite.count({ where: { orgId: ctx.orgId, status: "proposed", ...jobW } });
  }
  const rows = await core.list(ctx.orgSlug, "PENDING_WRITES", {
    maxRecords: 1000,
    filterByFormula: PROPOSED_PENDING_FORMULA,
  });
  if (scope.mode === "all") return rows.length;
  return rows.filter((r) => inScope(scope, proposalJobId(r["Job_Id"], str(r["Payload"])))).length;
}
