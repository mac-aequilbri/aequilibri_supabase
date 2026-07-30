// Meeting-minutes detail data source — Postgres. Backs
// /app/[org]/meeting-minutes/[id]. id is a numeric PK; the confirm form posts
// that same id back (confirmMeetingMinutes is RecordId-aware). extractedActions
// is stored as a JSON string and parsed here.

import { db, prisma } from "@/lib/db";
import type { ExtractedAction } from "./minutesDoc";
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

/** Load a single meeting-minutes detail view. */
export function loadMinutesDetail(ctx: OrgCtx, id: string): Promise<MinutesDetailView | null> {
  return fromPostgres(ctx, id);
}
