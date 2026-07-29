// Governance Phase 3 — row-level security (§3/§7): a user sees only the JOBS
// they're assigned to. Assignments live centrally in the control base's
// PLAT_ASSIGNMENTS table (one row per Org_Slug + Email + Job_Rec_Id) — beside
// the membership/roles that already live in PLAT_TEAM — not in a per-customer
// base (see docs/project-rls-activation.md, decision B).
//
// Tolerant by design: whenever a user's assignments can't be resolved (table
// absent/unreadable, no rows for the email, or a Postgres-registry org with no
// central store yet), scoping is OFF (null = whole tenant) — RLS tightens as
// assignments are seeded and never bricks an org. Administrator, Auditor, and
// Business Owner bypass via rlsExempt() at the call sites.

import { cache } from "react";
import { controlPlaneEnabled, listControlAssignments } from "@/lib/platform/controlPlane";
import { getCurrentViewer } from "./org-context";
import { rlsExempt } from "./roles";
import type { OrgCtx } from "./types";

/** Job record ids the user is assigned to in this org, or null = unscoped. */
export async function assignedJobRecIds(
  ctx: OrgCtx,
  email: string,
): Promise<ReadonlySet<string> | null> {
  // Postgres orgs resolve assignments from PlatCtlAssignment (control plane,
  // migration-plan Phase 3); Airtable orgs from the control base. No control
  // plane at all (Airtable mode without a control base) stays unscoped.
  if (!email || !controlPlaneEnabled()) return null;
  const rows = await listControlAssignments(ctx.orgSlug);
  const mine = rows.filter((a) => a.email === email.toLowerCase()).map((a) => a.jobRecId);
  return mine.length ? new Set(mine) : null;
}

// ── Job scope (governance §3/§7 RLS enforcement) ──────────────────────────────
// A viewer's row visibility resolves to one of three modes. Non-exempt roles
// see only their assigned JOBS; org-global rows (no Job link) are always visible.

export type JobScope =
  | { mode: "all" } // exempt role, or unresolved while fail-open (see rlsEnforce)
  | { mode: "some"; jobIds: ReadonlySet<string> }
  | { mode: "none" }; // explicitly no assignments, only while enforcing

/** Rollout gate, per org. Until an org's assignments are seeded, scoping stays
 *  fail-OPEN (an unresolved viewer sees everything) so enabling the code path
 *  never bricks an org. Two ways to flip an org to fail-CLOSED (unresolved →
 *  see-nothing) once its PLAT_ASSIGNMENTS are populated:
 *   - per-org: set `features.project_rls_enforce = true` in the org's settings
 *     (flows into ctx.config.features) — flip one base at a time; or
 *   - global: PROJECT_RLS_ENFORCE=true env — a staged-rollout/kill-switch that
 *     forces enforcement on for every org at once. */
export function rlsEnforce(ctx?: OrgCtx): boolean {
  if (process.env.PROJECT_RLS_ENFORCE === "true") return true;
  return ctx?.config?.features?.["project_rls_enforce"] === true;
}

/** Resolve a viewer to a job scope. Exempt (Administrator/Auditor/Business
 *  Owner) → all. Otherwise the viewer's TEAM→JOBS assignment; unresolved
 *  (no data / Postgres / table absent) obeys the fail-open/closed gate. */
export async function resolveJobScope(
  ctx: OrgCtx,
  viewer: { email: string; role: string },
): Promise<JobScope> {
  if (rlsExempt(viewer.role)) return { mode: "all" };
  // The org's "General" project is the shared bucket — always in scope for every
  // member, so org-level records are visible without leaking via a null job.
  const general = ctx.config?.generalJobId;
  const assigned = await assignedJobRecIds(ctx, viewer.email);
  if (assigned === null) {
    if (!rlsEnforce(ctx)) return { mode: "all" };
    // Enforcing with no assignments: the member still sees General, nothing else.
    return general ? { mode: "some", jobIds: new Set([general]) } : { mode: "none" };
  }
  const ids = new Set(assigned);
  if (general) ids.add(general);
  return { mode: "some", jobIds: ids };
}

/** The current request's viewer scope, resolved once (React-cached per request
 *  so many list sources on one page share a single TEAM read). Redirects from
 *  getCurrentViewer (denied non-member) propagate as normal. */
export const currentJobScope = cache(async (ctx: OrgCtx): Promise<JobScope> => {
  const viewer = await getCurrentViewer(ctx);
  return resolveJobScope(ctx, viewer);
});

/** Does the scope admit a single record with this job? `all` → always; a
 *  null/absent job is org-global and always visible; `none` → only org-global;
 *  `some` → the record's job is among the assigned set. The single-record twin
 *  of scopeRows — used by detail-page and write-path guards. */
export function inScope(scope: JobScope, jobId: string | null | undefined): boolean {
  if (scope.mode === "all") return true;
  if (jobId == null) return true; // org-global record
  if (scope.mode === "none") return false;
  return scope.jobIds.has(jobId);
}

/** Filter rows to a job scope. `all` → passthrough; `some` → rows on an assigned
 *  job OR with no job (org-global); `none` → only the no-job (org-global) rows.
 *  Pure — the seam every list/read path funnels through. */
export function scopeRows<T>(
  rows: T[],
  jobIdOf: (row: T) => string | null | undefined,
  scope: JobScope,
): T[] {
  if (scope.mode === "all") return rows;
  return rows.filter((r) => inScope(scope, jobIdOf(r)));
}

/** Convenience: resolve the current viewer's scope and filter an already-loaded
 *  list by each row's job. Call at the end of a list source's loader. */
export async function scopeByJob<T>(
  ctx: OrgCtx,
  rows: T[],
  jobIdOf: (row: T) => string | null | undefined,
): Promise<T[]> {
  return scopeRows(rows, jobIdOf, await currentJobScope(ctx));
}

/** Detail-page guard: is a freshly-fetched raw record in the viewer's scope?
 *  Reads the job from either an Airtable "Job" link array or a Postgres jobId
 *  scalar. A null record passes through (the loader's own not-found handling
 *  takes over). Call right after fetching, before mapping to a view. */
export async function recordInScope(
  ctx: OrgCtx,
  rec: Record<string, unknown> | null | undefined,
): Promise<boolean> {
  if (!rec) return true;
  const link = rec["Job"];
  const jobId =
    Array.isArray(link) && link.length > 0
      ? String(link[0])
      : rec["jobId"] != null
        ? String(rec["jobId"])
        : null;
  return inScope(await currentJobScope(ctx), jobId);
}
