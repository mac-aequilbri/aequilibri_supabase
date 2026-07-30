// Decisions data source — Postgres. The page renders a uniform DecisionView,
// the same shape (loader returning a view model) as the other pages.

import { db, prisma } from "@/lib/db";
import { recordInScope, scopeByJob } from "./rls";
import { dateInput, type EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface DecisionView {
  id: string;
  description: string;
  jobCode: string | null;
  jobId: string | null;
  rationale: string;
  madeBy: string;
  sourceType: string;
  status: string;
  date: string | Date | null;
}

async function fromPostgres(ctx: OrgCtx): Promise<DecisionView[]> {
  const rows = await db(ctx).platDecision.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { createdAt: "desc" },
    take: 2000,
    include: { job: { select: { code: true } } },
  });
  return rows.map((d) => ({
    id: String(d.id),
    description: d.description,
    jobCode: d.job?.code ?? null,
    jobId: d.jobId != null ? String(d.jobId) : null,
    rationale: d.rationale,
    madeBy: d.madeBy,
    sourceType: d.sourceType,
    status: d.status,
    date: d.decidedAt ?? d.createdAt,
  }));
}

/** Load decisions for the page. */
export async function loadDecisions(ctx: OrgCtx): Promise<DecisionView[]> {
  const rows = await fromPostgres(ctx);
  return scopeByJob(ctx, rows, (d) => d.jobId);
}

/** Form-ready values for a single decision's edit page (description,
 *  rationale, status, decidedAt). Null if the record isn't in this org. */
export async function loadDecisionDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  const d = await db(ctx).platDecision.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!d) return null;
  if (!(await recordInScope(ctx, d))) return null;
  return {
    description: d.description,
    rationale: d.rationale,
    status: d.status,
    decidedAt: dateInput(d.decidedAt),
  };
}
