// Variation detail data source — Postgres (default) or Airtable when the flag
// is on. Backs /app/[org]/variations/[id]. id is a numeric PK in Postgres mode
// and a "rec…" record id in Airtable mode; the approve/reject forms post that
// same id back (the service layer is RecordId-aware). jobCode is empty in
// Airtable mode (Airtable JOBS has no code field — see plan P4).

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { variationStatusFromAir } from "./changeLog";
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function dateOrNull(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
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

async function fromAirtable(ctx: OrgCtx, id: string): Promise<VariationDetailView | null> {
  if (!id.startsWith("rec")) return null;
  // Spec 12: a variation is a CHANGE_LOG row (Change_Type="Variation").
  let vo;
  try {
    vo = await core.get(ctx.orgSlug, "CHANGE_LOG", id);
  } catch {
    return null;
  }
  if (!(await recordInScope(ctx, vo))) return null;
  return {
    id: vo.id,
    refNumber: str(vo["Ref_Number"]),
    title: str(vo["Change_Name"]) || "(untitled variation)",
    description: str(vo["Description"]),
    scopeChange: str(vo["Scope_Change"]),
    costImpact: num(vo["Impact_Cost"]),
    timeImpactDays: num(vo["Impact_Schedule_Days"]),
    status: variationStatusFromAir(vo["Status"]),
    submittedBy: str(vo["Raised_By"]),
    isAiDrafted: vo["Is_AI_Drafted"] === true,
    approvedBy: str(vo["Approved_By"]),
    approvedAt: dateOrNull(vo["Date_Resolved"]),
    jobCode: "", // Airtable JOBS has no code field
  };
}

export function loadVariationDetail(ctx: OrgCtx, id: string): Promise<VariationDetailView | null> {
  return airtableEnabled(ctx) ? fromAirtable(ctx, id) : fromPostgres(ctx, id);
}
