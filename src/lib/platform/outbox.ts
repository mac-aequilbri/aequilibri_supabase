// Outbound event seam. The platform emits domain events (a proposal approved, a
// report sent, an assessment accepted) into PLAT_OUTBOX; a single n8n
// Airtable-trigger watches that table and delivers via the right channel.
//
// The platform owns the event contract only — n8n owns transport + credentials.
// Emission is:
//   - gated: no-op unless control is on AND the org has an active OUT connection
//     (so orgs not using outbound get zero outbox noise; the /integrations
//     toggle is the on/off switch),
//   - best-effort: fires AFTER the write/state-change has already landed and
//     never throws — a failed emit must never undo a completed write (mirrors
//     the best-effort audit log in recordWriter).

import { airtableEnabled, core } from "@/lib/airtable";
import {
  controlPlaneEnabled,
  enqueueOutbox,
  hasActiveOutbound,
  listFailedOutbox,
  setOutboxStatus,
} from "@/lib/platform/controlPlane";
import { prisma } from "@/lib/db";
import { logger, errMeta } from "@/lib/logger";
import type { OrgCtx } from "./types";
import type { RecordId } from "./recordWriter";

/** After this many failed delivery attempts an event is dead-lettered rather
 *  than re-driven. n8n bumps Attempts on each failed delivery. */
export const MAX_OUTBOX_ATTEMPTS = 5;

export async function emitOutboundEvent(
  ctx: OrgCtx,
  event: string,
  detail: {
    entityType: string;
    entityId: RecordId | undefined;
    jobId?: RecordId;
    summary?: string;
    data?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    if (!controlPlaneEnabled()) return;
    if (!(await hasActiveOutbound(ctx.orgSlug))) return;
    await enqueueOutbox({
      orgSlug: ctx.orgSlug,
      event,
      entityType: detail.entityType,
      entityId: detail.entityId == null ? "" : String(detail.entityId),
      jobId: detail.jobId == null ? undefined : String(detail.jobId),
      summary: detail.summary,
      data: detail.data,
    });
    // Surface the outbound event in the org's audit trail (Activity page reads
    // EXECUTION_LOG). Inbound is already audited via the document writes it
    // produces, so we only log the otherwise-invisible outbound path.
    await logIntegrationAudit(ctx, {
      label: `outbound:${event}`,
      summary: detail.summary || event,
      status: "executed",
    });
  } catch (err) {
    logger.warn("Outbound event emit skipped", { orgId: ctx.orgId, event, ...errMeta(err) });
  }
}

/** Whether a failed row should be re-driven (`pending`) or dead-lettered
 *  (`dead`). Pure — the redrive decision, unit-tested in isolation. */
export function outboxRedriveTarget(attempts: number, max = MAX_OUTBOX_ATTEMPTS): "pending" | "dead" {
  return attempts >= max ? "dead" : "pending";
}

/** Scheduler sweep: re-drive `failed` outbox rows. Under the attempt cap → back
 *  to `pending` (n8n re-picks it); at/over the cap → `dead` (DLQ). The platform
 *  only flips state — n8n owns delivery and bumps Attempts. Best-effort per row
 *  so one bad update never aborts the sweep. No-op unless control is on. */
export async function redriveOutbox(
  max = MAX_OUTBOX_ATTEMPTS,
): Promise<{ redriven: number; deadLettered: number }> {
  if (!controlPlaneEnabled()) return { redriven: 0, deadLettered: 0 };
  let redriven = 0;
  let deadLettered = 0;
  const failed = await listFailedOutbox();
  for (const row of failed) {
    const target = outboxRedriveTarget(row.attempts, max);
    try {
      await setOutboxStatus(row.recordId, target);
      if (target === "dead") deadLettered++;
      else redriven++;
    } catch (err) {
      logger.warn("Outbox redrive skipped a row", { recordId: row.recordId, ...errMeta(err) });
    }
  }
  return { redriven, deadLettered };
}

/** Best-effort integration audit entry in the org's EXECUTION_LOG (mirrors the
 *  audit write in recordWriter). Never throws. */
export async function logIntegrationAudit(
  ctx: OrgCtx,
  entry: { label: string; summary: string; status?: string },
): Promise<void> {
  const status = entry.status ?? "executed";
  try {
    if (airtableEnabled(ctx)) {
      await core.create(ctx.orgSlug, "EXECUTION_LOG", {
        Log_Entry: entry.label.slice(0, 200),
        Action_Type: "integration",
        Tables_Affected: "integration",
        Summary: entry.summary.slice(0, 800),
        Initiated_By: "System",
        Status: status,
        Date_Time: new Date().toISOString(),
      });
    } else {
      await prisma.platExecutionLog.create({
        data: {
          orgId: ctx.orgId,
          actorType: "system",
          actorName: "integration",
          operation: "integration",
          targetTable: "integration",
          payload: entry.label,
          status,
          executedAt: new Date(),
          result: entry.summary.slice(0, 800),
        },
      });
    }
  } catch (err) {
    logger.warn("Integration audit write skipped", { orgId: ctx.orgId, ...errMeta(err) });
  }
}
