// Domain-tier list-page data sources — Postgres. Groups the simple read-only
// list pages (Variations, Room Matrix, Meeting Minutes, Quotes, Weekly
// Reports) behind uniform view models.

import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { recordInScope, scopeByJob } from "./rls";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

// ── Variation Orders ───────────────────────────────────────────────────
export interface VariationView {
  id: string;
  refNumber: string;
  title: string;
  jobCode: string | null;
  jobId: string | null;
  isAiDrafted: boolean;
  costImpact: number;
  timeImpactDays: number;
  status: string;
}

export async function loadVariations(ctx: OrgCtx): Promise<VariationView[]> {
  return scopeByJob(ctx, await loadVariationsInner(ctx), (v) => v.jobId);
}
async function loadVariationsInner(ctx: OrgCtx): Promise<VariationView[]> {
  const rows = await db(ctx).platConVariationOrder.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { createdAt: "desc" },
    include: { job: { select: { code: true } } },
  });
  return rows.map((v) => ({
    id: String(v.id),
    refNumber: v.refNumber,
    title: v.title,
    jobCode: v.job?.code ?? null,
    jobId: v.jobId != null ? String(v.jobId) : null,
    isAiDrafted: v.isAiDrafted,
    costImpact: toNum(v.costImpact),
    timeImpactDays: v.timeImpactDays,
    status: v.status,
  }));
}

// ── Room Matrix ────────────────────────────────────────────────────────
export interface RoomView {
  id: string;
  name: string;
  zone: string;
  jobCode: string | null;
  jobId: string | null;
  areaSqm: number | null;
  ceilingHeight: string;
  /** JSON string of finishes (the page parses it). */
  finishes: string;
}

export async function loadRoomMatrix(ctx: OrgCtx): Promise<RoomView[]> {
  return scopeByJob(ctx, await loadRoomMatrixInner(ctx), (r) => r.jobId);
}
async function loadRoomMatrixInner(ctx: OrgCtx): Promise<RoomView[]> {
  const rows = await db(ctx).platConRoomMatrix.findMany({
    where: { orgId: ctx.orgId },
    orderBy: [{ zone: "asc" }, { name: "asc" }],
    include: { job: { select: { code: true } } },
  });
  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    zone: r.zone,
    jobCode: r.job?.code ?? null,
    jobId: r.jobId != null ? String(r.jobId) : null,
    areaSqm: r.areaSqm,
    ceilingHeight: r.ceilingHeight,
    finishes: r.finishes,
  }));
}

/** Form-ready values for a single room's edit page. */
export async function loadRoomDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  const r = await db(ctx).platConRoomMatrix.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!r) return null;
  if (!(await recordInScope(ctx, r))) return null;
  return {
    name: r.name,
    zone: r.zone,
    areaSqm: r.areaSqm ?? "",
    ceilingHeight: r.ceilingHeight,
  };
}

// ── Meeting Minutes ────────────────────────────────────────────────────
export interface MinutesView {
  id: string;
  title: string;
  meetingDate: Date | string | null;
  jobCode: string | null;
  jobId: string | null;
  actionsCount: number;
  status: string;
}

export async function loadMeetingMinutes(ctx: OrgCtx): Promise<MinutesView[]> {
  return scopeByJob(ctx, await loadMeetingMinutesInner(ctx), (m) => m.jobId);
}
async function loadMeetingMinutesInner(ctx: OrgCtx): Promise<MinutesView[]> {
  const rows = await db(ctx).platConMeetingMinutes.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { meetingDate: "desc" },
    include: { job: { select: { code: true } } },
  });
  return rows.map((m) => ({
    id: String(m.id),
    title: m.title,
    meetingDate: m.meetingDate,
    jobCode: m.job?.code ?? null,
    jobId: m.jobId != null ? String(m.jobId) : null,
    actionsCount: m.actionsCount,
    status: m.status,
  }));
}

// ── Quotes ─────────────────────────────────────────────────────────────
export interface QuoteView {
  id: string;
  refNumber: string;
  title: string;
  clientName: string;
  jobCode: string;
  jobId: string | null;
  validUntil: Date | string | null;
  total: number;
  status: string;
}

export async function loadQuotes(ctx: OrgCtx): Promise<QuoteView[]> {
  return scopeByJob(ctx, await loadQuotesInner(ctx), (q) => q.jobId);
}
async function loadQuotesInner(ctx: OrgCtx): Promise<QuoteView[]> {
  const rows = await db(ctx).platConQuote.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { createdAt: "desc" },
    include: { job: { select: { name: true, code: true } } },
  });
  return rows.map((q) => ({
    id: String(q.id),
    refNumber: q.refNumber,
    title: q.title,
    clientName: q.clientName,
    jobCode: q.job?.code ?? "",
    jobId: q.jobId != null ? String(q.jobId) : null,
    validUntil: q.validUntil,
    total: toNum(q.total),
    status: q.status,
  }));
}

// ── Weekly Reports ─────────────────────────────────────────────────────
export interface ReportView {
  id: string;
  title: string;
  weekEnding: Date | string | null;
  generatedAt: Date | string | null;
  jobCode: string | null;
  jobId: string | null;
  isAiGenerated: boolean;
  status: string;
}

export async function loadWeeklyReports(ctx: OrgCtx): Promise<ReportView[]> {
  return scopeByJob(ctx, await loadWeeklyReportsInner(ctx), (r) => r.jobId);
}
async function loadWeeklyReportsInner(ctx: OrgCtx): Promise<ReportView[]> {
  const rows = await db(ctx).platConWeeklyReport.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { weekEnding: "desc" },
    include: { job: { select: { code: true } } },
  });
  return rows.map((r) => ({
    id: String(r.id),
    title: r.title,
    weekEnding: r.weekEnding,
    generatedAt: r.generatedAt,
    jobCode: r.job?.code ?? null,
    jobId: r.jobId != null ? String(r.jobId) : null,
    isAiGenerated: r.isAiGenerated,
    status: r.status,
  }));
}
