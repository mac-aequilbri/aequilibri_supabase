// Domain-tier list-page data sources — Postgres (default) or the Airtable
// Domain Extension tables when AIRTABLE_MIGRATION is enabled. Groups the simple
// read-only list pages (Variations, Room Matrix, Meeting Minutes, Quotes,
// Weekly Reports) behind uniform view models. Detail pages and AI-generate
// actions are not source-switched yet — only the list reads.

import { airtableEnabled, core } from "@/lib/airtable";
import type { CoreRow } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { VARIATION_FILTER, variationStatusFromAir } from "./changeLog";
import { loadJobLabelMap } from "./jobOptionsSource";
import { recordInScope, scopeByJob } from "./rls";
import { MINUTES_DOC_TYPE, parseMinutesModule } from "./minutesDoc";
import { listOptional } from "./optionalList";
import { parseReportModule8, REPORT_DOC_TYPE } from "./reportDoc";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function firstLink(v: unknown): string | null {
  return Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
}

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
  if (!airtableEnabled(ctx)) {
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
  // Spec 12: variations are CHANGE_LOG rows (Change_Type="Variation").
  const [rows, jobLabels] = await Promise.all([
    core.list(ctx.orgSlug, "CHANGE_LOG", {
      maxRecords: 500,
      filterByFormula: VARIATION_FILTER,
    }),
    loadJobLabelMap(ctx),
  ]);
  return rows.map((r) => {
    const jobRec = firstLink(r["Job"]);
    return {
      id: r.id,
      refNumber: str(r["Ref_Number"]),
      title: str(r["Change_Name"]) || "(untitled variation)",
      jobCode: jobRec ? (jobLabels.get(jobRec) ?? null) : null,
      jobId: jobRec,
      isAiDrafted: r["Is_AI_Drafted"] === true,
      costImpact: num(r["Impact_Cost"]),
      timeImpactDays: num(r["Impact_Schedule_Days"]),
      status: variationStatusFromAir(r["Status"]),
    };
  });
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
  if (!airtableEnabled(ctx)) {
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
  const rows = await listOptional(ctx.orgSlug, "ROOM_MATRIX", { maxRecords: 200 });
  return rows.map((r) => ({
    id: r.id,
    name: str(r["Room_Name"]) || "(unnamed room)",
    zone: str(r["Zone"]),
    jobCode: null,
    jobId: firstLink(r["Job"]),
    areaSqm: typeof r["Area_Sqm"] === "number" ? (r["Area_Sqm"] as number) : null,
    ceilingHeight: str(r["Ceiling_Height"]),
    finishes: "{}", // no finishes field in the Airtable table yet
  }));
}

/** Form-ready values for a single room's edit page. Limited to the fields the
 *  Airtable ROOM_MATRIX table is known to carry (Finishes has no field yet). */
export async function loadRoomDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  if (airtableEnabled(ctx)) {
    let r: CoreRow | null = null;
    try {
      r = await core.get(ctx.orgSlug, "ROOM_MATRIX", id);
    } catch {
      return null;
    }
    if (!r) return null;
    if (!(await recordInScope(ctx, r))) return null;
    return {
      name: str(r["Room_Name"]),
      zone: str(r["Zone"]),
      areaSqm: typeof r["Area_Sqm"] === "number" ? (r["Area_Sqm"] as number) : "",
      ceilingHeight: str(r["Ceiling_Height"]),
    };
  }
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
  if (!airtableEnabled(ctx)) {
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
  // Spec 12: minutes are DOCUMENTS rows (Document_Type="Meeting Minutes") whose
  // metadata rides in AI_Analysis.minutes — see minutesDoc.ts.
  const [rows, jobLabels] = await Promise.all([
    core.list(ctx.orgSlug, "DOCUMENTS", {
      maxRecords: 500,
      filterByFormula: `{Document_Type}='${MINUTES_DOC_TYPE}'`,
    }),
    loadJobLabelMap(ctx),
  ]);
  return rows
    .map((r) => ({ r, m: parseMinutesModule(r["AI_Analysis"]) }))
    .filter((x): x is { r: CoreRow; m: NonNullable<typeof x.m> } => x.m != null)
    .map(({ r, m }) => {
      const jobRec = firstLink(r["Job"]);
      return {
        id: r.id,
        title: str(r["Document_Name"]) || `Meeting ${m.meetingDate}`,
        meetingDate: m.meetingDate || null,
        jobCode: jobRec ? (jobLabels.get(jobRec) ?? null) : null,
        jobId: jobRec,
        actionsCount: m.actionsCount,
        status: m.status,
      };
    });
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
  if (!airtableEnabled(ctx)) {
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
  const [rows, jobLabels] = await Promise.all([
    listOptional(ctx.orgSlug, "QUOTES", { maxRecords: 200 }),
    loadJobLabelMap(ctx),
  ]);
  return rows.map((r) => {
    const jobRec = firstLink(r["Job"]);
    return {
      id: r.id,
      refNumber: str(r["Ref_Number"]),
      title: str(r["Title"]) || "(untitled quote)",
      clientName: str(r["Client_Name"]),
      jobCode: (jobRec && jobLabels.get(jobRec)) || "",
      jobId: jobRec,
      validUntil: str(r["Valid_Until"]) || null,
      total: num(r["Total"]),
      status: str(r["Status"]) || "draft",
    };
  });
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
  if (!airtableEnabled(ctx)) {
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
  // Spec 12: a weekly report is a DOCUMENTS row (Document_Type=report) whose
  // lifecycle rides in AI_Analysis.module8 — see reportDoc.ts. Narrow by type in
  // the query, then confirm the module8 tag so other "report" docs are excluded.
  const rows = await core.list(ctx.orgSlug, "DOCUMENTS", {
    maxRecords: 500,
    filterByFormula: `LOWER({Document_Type})='${REPORT_DOC_TYPE.toLowerCase()}'`,
  });
  return rows
    .map((r) => ({ r, m8: parseReportModule8(r["AI_Analysis"]) }))
    .filter((x): x is { r: CoreRow; m8: NonNullable<typeof x.m8> } => x.m8 != null)
    .map(({ r, m8 }) => ({
      id: r.id,
      title: str(r["Document_Name"]) || `Week ending ${m8.weekEnding}`,
      weekEnding: m8.weekEnding || null,
      generatedAt: m8.generatedAt || str(r["Upload_Date"]) || null,
      jobCode: null,
      jobId: firstLink(r["Job"]),
      isAiGenerated: m8.isAiGenerated,
      status: m8.status,
    }));
}
