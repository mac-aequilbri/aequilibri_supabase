// Meeting minutes — AI extraction of action items, human confirmation
// creates real Action Hub rows (sourceType=meeting_minutes).
//
// Storage model differs by backend. Postgres keeps the rich
// plat_con_meetingminutes model. Airtable (Spec 12) has no MEETING_MINUTES
// table, so minutes are a DOCUMENTS row: raw minutes in Text_Content, metadata +
// extracted actions + lifecycle in AI_Analysis.minutes (see minutesDoc.ts).

import { airtableEnabled, core } from "@/lib/airtable";
import { callClaude } from "@/lib/claude";
import { db, prisma } from "@/lib/db";
import {
  buildMinutesAnalysis,
  MINUTES_DOC_TYPE,
  parseMinutesModule,
  patchMinutesAnalysis,
} from "@/lib/platform/minutesDoc";
import { modelFor } from "@/lib/platform/modelRouter";
import { getPrompt } from "@/lib/platform/prompts";
import { writeRecord, type RecordId } from "@/lib/platform/recordWriter";
import { OrgCtx } from "@/lib/platform/types";

export type { ExtractedAction } from "@/lib/platform/minutesDoc";
import type { ExtractedAction } from "@/lib/platform/minutesDoc";

function parseActions(raw: unknown): ExtractedAction[] {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ExtractedAction[]) : [];
  } catch {
    return [];
  }
}

/** Create one Action Hub row per extracted action. Shared by both backends;
 *  jobId is whatever link the minutes carried (dropped by the ISSUES map in
 *  Airtable mode, which has no Job link). Returns the number of actions created. */
async function createActions(
  ctx: OrgCtx,
  userName: string,
  minutesId: RecordId,
  jobId: RecordId | undefined,
  actions: ExtractedAction[],
): Promise<number> {
  let created = 0;
  for (const a of actions) {
    if (!a.title) continue;
    await writeRecord(ctx, {
      table: "action",
      op: "create",
      data: {
        jobId,
        title: a.title,
        owner: a.owner,
        dueDate: a.dueDate ?? undefined,
        sourceType: "meeting_minutes",
        sourceId: minutesId,
      },
      actor: { type: "human", name: userName },
    });
    created++;
  }
  return created;
}

export async function processMeetingMinutes(
  ctx: OrgCtx,
  userName: string,
  input: { jobId: RecordId; meetingDate: string; title: string; attendees: string; rawMinutes: string },
): Promise<{ id?: RecordId; actionsCount: number; demoMode: boolean }> {
  const { system } = getPrompt("minutes.extract");
  const res = await callClaude(system, input.rawMinutes.slice(0, 12000), {
    model: modelFor("extraction"),
    maxTokens: 1200,
  });

  let actions: ExtractedAction[] = [];
  if (!res.demo_mode) {
    try {
      const parsed = JSON.parse(res.content.replace(/^```(json)?|```$/g, "").trim());
      if (Array.isArray(parsed.actions)) {
        actions = parsed.actions
          .filter((a: unknown) => a && typeof a === "object" && (a as { title?: unknown }).title)
          .map((a: { title: unknown; owner?: unknown; dueDate?: unknown }) => ({
            title: String(a.title).slice(0, 300),
            owner: String(a.owner ?? "").slice(0, 200),
            dueDate: a.dueDate && /^\d{4}-\d{2}-\d{2}/.test(String(a.dueDate)) ? String(a.dueDate) : null,
          }));
      }
    } catch {
      actions = [];
    }
  }
  const status = res.demo_mode ? "raw" : "processed";

  // Airtable (Spec 12): minutes are a DOCUMENTS row.
  if (airtableEnabled(ctx)) {
    const result = await writeRecord(ctx, {
      table: "document",
      op: "create",
      data: {
        jobId: input.jobId,
        title: input.title || `Meeting ${input.meetingDate}`,
        docType: MINUTES_DOC_TYPE,
        status: "Active",
        uploadedBy: userName,
        textContent: input.rawMinutes,
        aiAnalysis: buildMinutesAnalysis({
          kind: "meeting_minutes",
          meetingDate: input.meetingDate,
          attendees: input.attendees,
          status,
          extractedActions: actions,
          actionsCount: actions.length,
        }),
      },
      actor: { type: "human", name: userName },
    });
    return { id: result.recordId, actionsCount: actions.length, demoMode: res.demo_mode };
  }

  const result = await writeRecord(ctx, {
    table: "meeting_minutes",
    op: "create",
    data: {
      jobId: input.jobId,
      meetingDate: input.meetingDate,
      title: input.title,
      attendees: input.attendees,
      rawMinutes: input.rawMinutes,
      extractedActions: JSON.stringify(actions),
      actionsCount: actions.length,
      status,
    },
    actor: { type: "human", name: userName },
  });
  return { id: result.recordId, actionsCount: actions.length, demoMode: res.demo_mode };
}

/** Human gate: confirming the minutes creates the extracted actions for real. */
export async function confirmMeetingMinutes(
  ctx: OrgCtx,
  userName: string,
  id: RecordId,
): Promise<number> {
  if (airtableEnabled(ctx)) {
    const doc = await core.get(ctx.orgSlug, "DOCUMENTS", String(id)).catch(() => null);
    const m = doc ? parseMinutesModule(doc["AI_Analysis"]) : null;
    if (!m || m.status === "confirmed") return 0;
    const jobLink = doc?.["Job"];
    const jobId = Array.isArray(jobLink) && jobLink.length ? String(jobLink[0]) : undefined;
    const created = await createActions(ctx, userName, id, jobId, m.extractedActions);
    await writeRecord(ctx, {
      table: "document",
      op: "update",
      recordId: id,
      data: {
        aiAnalysis: patchMinutesAnalysis(doc?.["AI_Analysis"], {
          status: "confirmed",
          confirmedAt: new Date().toISOString(),
          actionsCount: created,
        }),
      },
      actor: { type: "human", name: userName },
    });
    return created;
  }

  const minutes = await db(ctx).platConMeetingMinutes.findFirst({
    where: { id: Number(id), orgId: ctx.orgId },
  });
  if (!minutes || minutes.status === "confirmed") return 0;

  const created = await createActions(
    ctx,
    userName,
    minutes.id,
    minutes.jobId,
    parseActions(minutes.extractedActions),
  );
  await writeRecord(ctx, {
    table: "meeting_minutes",
    op: "update",
    recordId: minutes.id,
    data: { status: "confirmed", confirmedAt: new Date().toISOString(), actionsCount: created },
    actor: { type: "human", name: userName },
  });
  return created;
}
