import { db, prisma } from "@/lib/db";
import type { ReportPromptSpec } from "./reportDoc";
import { recordInScope } from "./rls";
import type { OrgCtx } from "./types";

export interface ReportDetailView {
  id: string;
  title: string;
  weekEnding: Date | null;
  generatedAt: Date | null;
  content: string;
  status: string;
  approvedBy: string;
  approvedAt: Date | null;
  sentAt: Date | null;
  jobCode: string;
  jobName: string;
  /** Present on prompt-built custom reports — enables Regenerate. */
  promptSpec: ReportPromptSpec | null;
}

async function fromPostgres(ctx: OrgCtx, id: string): Promise<ReportDetailView | null> {
  const reportId = Number(id);
  if (!Number.isInteger(reportId)) return null;
  const report = await db(ctx).platConWeeklyReport.findFirst({
    where: { id: reportId, orgId: ctx.orgId },
    include: { job: { select: { code: true, name: true } } },
  });
  if (!report) return null;
  if (!(await recordInScope(ctx, report))) return null;
  return {
    id: String(report.id),
    title: report.title,
    weekEnding: report.weekEnding,
    generatedAt: report.generatedAt,
    content: report.content,
    status: report.status,
    approvedBy: report.approvedBy,
    approvedAt: report.approvedAt,
    sentAt: report.sentAt,
    jobCode: report.job?.code ?? "",
    jobName: report.job?.name ?? "",
    promptSpec: null,
  };
}

export function loadReportDetail(ctx: OrgCtx, id: string): Promise<ReportDetailView | null> {
  return fromPostgres(ctx, id);
}
