// PLAN task-level schedule (Spec 12 Core / Module 5 construct 5) — was
// Airtable-only, like COMMS: PLAN has no Postgres model, so reads return an
// empty list until one lands.

import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface PlanTaskView {
  id: string;
  name: string;
  jobId: string | null;
  jobName: string | null;
  phaseId: string | null;
  phaseName: string | null;
  startDate: Date | null;
  endDate: Date | null;
  durationDays: number;
  /** Canonical PLAN status (vocab.ts): Not Started · In Progress · Complete ·
   *  Blocked · Deferred. */
  status: string;
  rag: string;
  /** Resolved CONTACTS name(s) for the Assigned_To link, "" when unassigned. */
  assignedTo: string;
  predecessorIds: string[];
  notes: string;
  /** Derived: past its end date and not Complete. */
  isOverdue: boolean;
}

/** Load the task schedule. PLAN has no Postgres model, so this is always
 *  empty. */
export async function loadPlanTasks(_ctx: OrgCtx): Promise<PlanTaskView[]> {
  return [];
}

/** Form-ready values for a single task's detail/edit page. PLAN has no
 *  Postgres model, so always null (matching loadCommDetail). */
export async function loadPlanTaskDetail(_ctx: OrgCtx, _id: string): Promise<EditorValues | null> {
  return null;
}
