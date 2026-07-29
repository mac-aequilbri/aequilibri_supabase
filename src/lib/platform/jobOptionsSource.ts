// Job-picker options — Postgres (default) or Airtable when the flag is on. The
// shared source behind every job <select> on the create/generate pages. Each
// option's id MUST be the id the write path expects: a numeric PK in Postgres
// mode, a "rec…" record id in Airtable mode. Posting that id back lets the
// recordWriter link the new record to its job (the Job field maps use the LINK
// codec, which emits a link only for "rec…" ids) — so for an Airtable-only org
// these pickers are what makes "create X against job Y" reachable at all.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { currentJobScope, inScope } from "./rls";
import type { OrgCtx } from "./types";

export interface JobOption {
  id: string;
  /** Display label: "CODE — Name" in Postgres mode, just the name in Airtable
   *  mode (Airtable JOBS has no code field — see plan P4). */
  label: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function fromPostgres(ctx: OrgCtx): Promise<JobOption[]> {
  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId },
    select: { id: true, code: true, name: true },
    orderBy: { code: "asc" },
  });
  return jobs.map((j) => ({ id: String(j.id), label: `${j.code} — ${j.name}` }));
}

async function fromAirtable(ctx: OrgCtx): Promise<JobOption[]> {
  const jobs = await core.list(ctx.orgSlug, "JOBS", { maxRecords: 200 });
  return jobs
    .map((j) => ({ id: j.id, label: str(j["Job_Name"]) || "(job)" }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Load the job-picker options from whichever backend is active — RLS-scoped to
 *  the viewer's assigned jobs (+ their org's General project). A scoped user
 *  can only file records against, or target, projects they're assigned to. */
export async function loadJobOptions(ctx: OrgCtx): Promise<JobOption[]> {
  const all = await (airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx));
  const scope = await currentJobScope(ctx);
  return scope.mode === "all" ? all : all.filter((o) => inScope(scope, o.id));
}

/** Airtable JOBS record id → job display name, for resolving the `Job` link on
 *  list rows into a groupable/displayable label. Reuses the same TTL-cached
 *  JOBS read as loadJobOptions, so it adds no Airtable API calls when the cache
 *  is warm. Empty in Postgres mode — those sources resolve the job through a
 *  Prisma relation include instead. (Plan P4: unlocks "group by project".) */
export async function loadJobLabelMap(ctx: OrgCtx): Promise<Map<string, string>> {
  if (!airtableEnabled(ctx)) return new Map();
  const jobs = await core.list(ctx.orgSlug, "JOBS", { maxRecords: 200 });
  return new Map(jobs.map((j) => [j.id, str(j["Job_Name"]) || "(job)"]));
}
