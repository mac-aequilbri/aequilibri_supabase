// COMMS coordination layer (Spec 10 Core) — "who gets told what, by when".
// Was Airtable-only: COMMS has no Postgres model (like ASSESSMENTS), so reads
// return an empty list until one lands.

import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface CommView {
  id: string;
  topic: string;
  messageType: string;
  stakeholderRole: string;
  /** Lower-cased app status: pending | sent | acknowledged | overdue. */
  status: string;
  dueDate: Date | null;
  sentBy: string;
  notes: string;
  jobId: string | null;
  jobName: string | null;
  stakeholderId: string | null;
  /** Derived: still pending and past its due date. */
  isOverdue: boolean;
}

/** Load the coordination schedule. COMMS has no Postgres model, so this is
 *  always empty. */
export async function loadComms(_ctx: OrgCtx): Promise<CommView[]> {
  return [];
}

/** Form-ready values for a single communication's edit page. COMMS has no
 *  Postgres model, so always null. */
export async function loadCommDetail(_ctx: OrgCtx, _id: string): Promise<EditorValues | null> {
  return null;
}
