// Spec 12 Module 6 — JOBS completion deltas (lock plan §6.2). When a job's
// status transitions to Closed, engagement-level deltas (budget, schedule,
// scope-change count) feed the Learning Loop.
//
// The post-write hook that populated these deltas was Airtable-mode only; with
// the Airtable migration retired it no-ops until a Postgres equivalent lands.
// The pure delta maths (computeJobCloseDeltas) and the materiality thresholds
// remain — they are unit-tested and backend-agnostic.

import type { CascadeWrite } from "@/lib/platform/cascade";
import type { OrgCtx } from "@/lib/platform/types";

/** Budget variance at/above this (absolute %) marks the job a learning-rule
 *  candidate and emits a module6 correction. Default, owner-tunable later. */
export const JOB_CLOSE_VARIANCE_PCT = 10;
/** Schedule slip at/above this many days emits a module6 correction. */
export const JOB_CLOSE_SCHEDULE_DAYS = 7;

export interface JobCloseDeltas {
  estimated: number;
  actual: number;
  variancePct: number | null;
  plannedEnd: string | null;
  completedAt: string;
  scheduleDeltaDays: number | null;
  scopeChangesCount: number;
}

/** Pure delta maths — unit-testable. */
export function computeJobCloseDeltas(args: {
  estimated: number;
  actual: number;
  plannedEnd: string | null;
  completedAt: string;
  scopeChangesCount: number;
}): JobCloseDeltas {
  const variancePct =
    args.estimated !== 0
      ? Math.round(((args.actual - args.estimated) / Math.abs(args.estimated)) * 1000) / 10
      : null;
  const scheduleDeltaDays = args.plannedEnd
    ? Math.round(
        (new Date(args.completedAt).getTime() - new Date(args.plannedEnd).getTime()) / 86_400_000,
      )
    : null;
  return { ...args, variancePct, scheduleDeltaDays };
}

/** Post-write hook: populate the completion deltas when a JOBS write closes
 *  the job. The Airtable-mode implementation was removed with the migration —
 *  currently a no-op (kept so recordWriter's hook wiring is unchanged). */
export async function handleJobCompletion(_ctx: OrgCtx, _write: CascadeWrite): Promise<void> {}
