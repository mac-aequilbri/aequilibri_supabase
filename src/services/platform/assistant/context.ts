// Spec 12 Module 7 context loading strategy (lock plan §7.1). The rich
// session-context block was an Airtable-mode enhancement; with the Airtable
// migration retired, Postgres keeps the lean legacy snapshot from dataContext
// and this block is always empty. The exports remain so chat.ts and
// recordWriter's post-write hook keep their call sites unchanged.

import type { OrgCtx } from "@/lib/platform/types";
import type { RecordId } from "@/lib/platform/recordWriter";

/** Drop every cached context for the org — called from recordWriter's
 *  post-write hook. No-op now that no context is cached. */
export function invalidateAssistantContext(_orgSlug: string): void {}

/** The session context block (Spec 12 Module 7) for the system prompt.
 *  Always "" — the block was Airtable-mode only. */
export async function jobContextBlock(
  _ctx: OrgCtx,
  _opts: { jobId?: RecordId; role?: string },
): Promise<string> {
  return "";
}
