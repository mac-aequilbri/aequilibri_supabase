// Execution-log history source — Postgres.
//
// Scope note: this source returns audit history only; pending approvals are
// loaded separately from pendingWritesSource.

import { db, prisma } from "@/lib/db";
import type { OrgCtx } from "./types";

export interface LogView {
  id: string;
  operation: string;
  targetTable: string;
  actorType: string;
  actorName: string;
  approvedBy: string;
  payload: string;
  status: string;
  error: string;
  createdAt: Date | null;
}

async function fromPostgres(ctx: OrgCtx): Promise<LogView[]> {
  const logs = await db(ctx).platExecutionLog.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return logs.map((l) => ({
    id: String(l.id),
    operation: l.operation,
    targetTable: l.targetTable,
    actorType: l.actorType,
    actorName: l.actorName,
    approvedBy: l.approvedBy,
    payload: l.payload,
    status: l.status,
    error: l.error,
    createdAt: l.createdAt,
  }));
}

/** Load the execution-log history. */
export function loadExecLogHistory(ctx: OrgCtx): Promise<LogView[]> {
  return fromPostgres(ctx);
}
