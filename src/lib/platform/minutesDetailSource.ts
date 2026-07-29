// Meeting-minutes detail data source — Postgres (default) or Airtable when the
// flag is on. Backs /app/[org]/meeting-minutes/[id]. id is a numeric PK in
// Postgres mode and a "rec…" record id in Airtable mode; the confirm form posts
// that same id back (confirmMeetingMinutes is RecordId-aware). extractedActions
// is stored as a JSON string in both backends and parsed here. jobCode is empty
// in Airtable mode (Airtable JOBS has no code field — see plan P4).

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { type ExtractedAction, parseMinutesModule } from "./minutesDoc";
import { recordInScope } from "./rls";
import type { OrgCtx } from "./types";

export interface MinutesDetailView {
  id: string;
  title: string;
  meetingDate: Date | null;
  attendees: string;
  status: string;
  rawMinutes: string;
  extractedActions: ExtractedAction[];
  confirmedAt: Date | null;
  jobCode: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function dateOrNull(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** Parse the stored JSON action list, tolerating malformed/empty content. */
function parseActions(raw: unknown): ExtractedAction[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ExtractedAction[]) : [];
  } catch {
    return [];
  }
}

async function fromPostgres(ctx: OrgCtx, id: string): Promise<MinutesDetailView | null> {
  const recId = Number(id);
  if (!Number.isInteger(recId)) return null;
  const minutes = await db(ctx).platConMeetingMinutes.findFirst({
    where: { id: recId, orgId: ctx.orgId },
    include: { job: { select: { code: true } } },
  });
  if (!minutes) return null;
  if (!(await recordInScope(ctx, minutes))) return null;
  return {
    id: String(minutes.id),
    title: minutes.title,
    meetingDate: minutes.meetingDate,
    attendees: minutes.attendees,
    status: minutes.status,
    rawMinutes: minutes.rawMinutes,
    extractedActions: parseActions(minutes.extractedActions),
    confirmedAt: minutes.confirmedAt,
    jobCode: minutes.job?.code ?? "",
  };
}

async function fromAirtable(ctx: OrgCtx, id: string): Promise<MinutesDetailView | null> {
  if (!id.startsWith("rec")) return null;
  // Spec 12: minutes are a DOCUMENTS row — raw minutes in Text_Content, metadata
  // in AI_Analysis.minutes (see minutesDoc.ts). A doc without that block is not a
  // minutes record → treated as not-found.
  let doc;
  try {
    doc = await core.get(ctx.orgSlug, "DOCUMENTS", id);
  } catch {
    return null; // 404 / deleted / wrong-base → not found
  }
  if (!(await recordInScope(ctx, doc))) return null;
  const m = parseMinutesModule(doc["AI_Analysis"]);
  if (!m) return null;
  return {
    id: doc.id,
    title: str(doc["Document_Name"]),
    meetingDate: dateOrNull(m.meetingDate),
    attendees: m.attendees,
    status: m.status,
    rawMinutes: str(doc["Text_Content"]),
    extractedActions: m.extractedActions,
    confirmedAt: dateOrNull(m.confirmedAt),
    jobCode: "", // Airtable JOBS has no code field (see plan P4)
  };
}

/** Load a single meeting-minutes detail view from whichever backend is active. */
export function loadMinutesDetail(ctx: OrgCtx, id: string): Promise<MinutesDetailView | null> {
  return airtableEnabled(ctx) ? fromAirtable(ctx, id) : fromPostgres(ctx, id);
}
