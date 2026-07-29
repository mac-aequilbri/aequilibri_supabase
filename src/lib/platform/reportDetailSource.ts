import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { parseReportModule8, type ReportPromptSpec } from "./reportDoc";
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function dateOrNull(v: unknown): Date | null {
  const raw = str(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function firstLink(v: unknown): string | null {
  return Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
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

async function fromAirtable(ctx: OrgCtx, id: string): Promise<ReportDetailView | null> {
  if (!id.startsWith("rec")) return null;
  // Spec 12: a weekly report is a DOCUMENTS row — body in Text_Content, lifecycle
  // in AI_Analysis.module8 (see reportDoc.ts). A rec id that isn't a report doc
  // (no module8 tag) is treated as not-found.
  const doc = await core.get(ctx.orgSlug, "DOCUMENTS", id).catch(() => null);
  if (!doc) return null;
  if (!(await recordInScope(ctx, doc))) return null;
  const m8 = parseReportModule8(doc["AI_Analysis"]);
  if (!m8) return null;
  const jobId = firstLink(doc["Job"]);
  const job = jobId ? await core.get(ctx.orgSlug, "JOBS", jobId).catch(() => null) : null;
  return {
    id: doc.id,
    title: str(doc["Document_Name"]),
    weekEnding: dateOrNull(m8.weekEnding),
    generatedAt: dateOrNull(m8.generatedAt) ?? dateOrNull(doc["Upload_Date"]),
    content: str(doc["Text_Content"]),
    status: m8.status,
    approvedBy: m8.approvedBy ?? "",
    approvedAt: dateOrNull(m8.approvedAt),
    sentAt: dateOrNull(m8.sentAt),
    jobCode: "",
    jobName: job ? str(job["Job_Name"]) : "",
    promptSpec: m8.promptSpec ?? null,
  };
}

export function loadReportDetail(ctx: OrgCtx, id: string): Promise<ReportDetailView | null> {
  return airtableEnabled(ctx) ? fromAirtable(ctx, id) : fromPostgres(ctx, id);
}
