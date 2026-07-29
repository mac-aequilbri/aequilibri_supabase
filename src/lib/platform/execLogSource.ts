// Execution-log history source — Postgres (default) or the canonical Airtable
// EXECUTION_LOG table when AIRTABLE_MIGRATION is enabled.
//
// Scope note: this source returns audit history only; pending approvals are
// loaded separately from pendingWritesSource.

import { airtableEnabled, core } from "@/lib/airtable";
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
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

async function fromAirtable(ctx: OrgCtx): Promise<LogView[]> {
  const rows = await core.list(ctx.orgSlug, "EXECUTION_LOG", { maxRecords: 100 });
  return rows.map((r) => {
    const when = str(r["Date_Time"]) || str(r["Session_Date"]);
    const contributor = r["Contributor"];
    return {
      id: r.id,
      operation: str(r["Action_Type"]), // ASSUMPTION: Action_Type ~= operation
      targetTable: str(r["Tables_Affected"]), // ASSUMPTION: free-text table list
      actorType: str(r["Initiated_By"]).toLowerCase(), // AI|Owner|System
      actorName: Array.isArray(contributor) && contributor.length > 0 ? "(linked)" : "",
      approvedBy: "",
      payload: str(r["Summary"]) || str(r["Log_Entry"]),
      status: str(r["Status"]),
      error: "",
      createdAt: when ? new Date(when) : null,
    };
  });
}

/** Load the execution-log history from whichever backend is active. */
export function loadExecLogHistory(ctx: OrgCtx): Promise<LogView[]> {
  return airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx);
}
