// Variation detail data source — Postgres. Backs /app/[org]/variations/[id].
// id is a numeric PK; the approve/reject forms post that same id back.

import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { recordInScope } from "./rls";
import type { OrgCtx } from "./types";

export interface VariationDetailView {
  id: string;
  refNumber: string;
  title: string;
  description: string;
  scopeChange: string;
  costImpact: number;
  timeImpactDays: number;
  status: string;
  submittedBy: string;
  isAiDrafted: boolean;
  approvedBy: string;
  approvedAt: Date | null;
  jobCode: string;
}

async function fromPostgres(ctx: OrgCtx, id: string): Promise<VariationDetailView | null> {
  const recId = Number(id);
  if (!Number.isInteger(recId)) return null;
  const vo = await db(ctx).platConVariationOrder.findFirst({
    where: { id: recId, orgId: ctx.orgId },
    include: { job: { select: { code: true } } },
  });
  if (!vo) return null;
  if (!(await recordInScope(ctx, vo))) return null;
  return {
    id: String(vo.id),
    refNumber: vo.refNumber,
    title: vo.title,
    description: vo.description ?? "",
    scopeChange: vo.scopeChange ?? "",
    costImpact: toNum(vo.costImpact),
    timeImpactDays: vo.timeImpactDays,
    status: vo.status,
    submittedBy: vo.submittedBy ?? "",
    isAiDrafted: vo.isAiDrafted,
    approvedBy: vo.approvedBy ?? "",
    approvedAt: vo.approvedAt,
    jobCode: vo.job?.code ?? "",
  };
}

export function loadVariationDetail(ctx: OrgCtx, id: string): Promise<VariationDetailView | null> {
  return fromPostgres(ctx, id);
}
