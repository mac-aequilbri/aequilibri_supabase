import { db, prisma } from "@/lib/db";
import type { RecordId } from "@/lib/platform/recordWriter";
import { proposalJobId } from "./proposalSource";
import { currentJobScope } from "./rls";
import type { OrgCtx } from "./types";

export interface PendingWriteView {
  id: RecordId;
  tableKey: string;
  op: string;
  recordId: string;
  /** The proposal's target job (numeric string), for RLS scoping of the
   *  approval queue. null = org-global. */
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

export function loadPendingWrites(ctx: OrgCtx): Promise<PendingWriteView[]> {
  return fromPostgres(ctx);
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
  const ids = scope.mode === "some" ? [...scope.jobIds].map(Number).filter((n) => Number.isFinite(n)) : null;
  const jobW = ids ? { jobId: { in: ids } } : scope.mode === "none" ? { jobId: -1 } : {};
  return db(ctx).platPendingWrite.count({ where: { orgId: ctx.orgId, status: "proposed", ...jobW } });
}
