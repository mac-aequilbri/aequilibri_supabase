// Risk register data source — Postgres. Status values
// (open/accepted/mitigated/closed) match the app's, so no remapping is needed.

import { db, prisma } from "@/lib/db";
import { recordInScope, scopeByJob } from "./rls";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface RiskView {
  id: string;
  description: string;
  jobCode: string | null;
  jobId: string | null;
  likelihood: number;
  impact: number;
  mitigation: string;
  status: string;
  owner: string;
  escalatedAt: Date | null;
  escalationNote: string;
  createdByAi: boolean;
  // Spec 12 Module 5 RISKS fields — empty: the Postgres model has no
  // category/rag columns yet.
  category: string;
  rag: string;
}

async function fromPostgres(ctx: OrgCtx): Promise<RiskView[]> {
  const risks = await db(ctx).platConRisk.findMany({
    where: { orgId: ctx.orgId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { job: { select: { code: true } } },
  });
  return risks.map((r) => ({
    id: String(r.id),
    description: r.description,
    jobCode: r.job?.code ?? null,
    jobId: r.jobId != null ? String(r.jobId) : null,
    likelihood: r.likelihood,
    impact: r.impact,
    mitigation: r.mitigation,
    status: r.status,
    owner: r.owner,
    escalatedAt: r.escalatedAt,
    escalationNote: r.escalationNote,
    createdByAi: r.createdByAi,
    category: "", // Postgres model has no category/rag columns
    rag: "",
  }));
}

/** Load the risk register. */
export async function loadRisks(ctx: OrgCtx): Promise<RiskView[]> {
  const rows = await fromPostgres(ctx);
  return scopeByJob(ctx, rows, (r) => r.jobId);
}

/** Form-ready values for a single risk's edit page. Null if not in this org. */
export async function loadRiskDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  const r = await db(ctx).platConRisk.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!r) return null;
  if (!(await recordInScope(ctx, r))) return null;
  return {
    description: r.description,
    likelihood: r.likelihood,
    impact: r.impact,
    mitigation: r.mitigation,
    owner: r.owner,
    status: r.status,
  };
}
