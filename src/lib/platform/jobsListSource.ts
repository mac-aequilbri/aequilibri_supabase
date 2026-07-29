// Projects (jobs) LIST data source — Postgres (default) or Airtable when the
// flag is on. Backs /app/[org]/projects. The list MUST emit the same id the
// detail page (jobDetailSource) resolves: a numeric PK in Postgres mode, a
// "rec…" id in Airtable mode. The old page read Postgres directly and linked
// numeric ids, so in Airtable mode the cards either hid Airtable-created jobs
// or 404'd the detail page — this source fixes that mismatch.
//
// Airtable JOBS is leaner than PlatJob (no code/engagementType/address/health),
// so those degrade to empty/zero; completionPct is derived from the job's
// non-draft phases, and per-job phase/risk counts are computed by grouping the
// PHASES/RISKS tables on their Job link (ACTION_HUB has no Job link, so the
// action count is 0 in Airtable mode — matching jobDetailSource).

import { airtableEnabled, core } from "@/lib/airtable";
import { listPage } from "@/lib/airtable/client";
import { resolveBaseId } from "@/lib/airtable/config";
import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { normalizeEngagementType } from "./engagementProfile";
import { computeJobRag } from "./jobRag";
import { normalizeRag } from "./phasesSource";
import { resolveJobScope, scopeRows } from "./rls";
import type { OrgCtx } from "./types";

export interface JobListView {
  id: string;
  name: string;
  code: string;
  engagementType: string;
  address: string;
  suburb: string;
  status: string;
  completionPct: number;
  healthScore: number;
  budgetTotal: number;
  /** Derived engagement RAG from the job's phases (jobRag.ts); "" = no signal.
   *  Consumers with an ISSUES read (dashboard) recompute with blocker counts. */
  rag: string;
  /** The phase RAG cells behind `rag`, so consumers can re-aggregate with more
   *  context (open Blockers) without another PHASES read. */
  phaseRags: string[];
  counts: { phases: number; actions: number; risks: number };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
/** Whether a linked-record cell points at the given record id. */
function linksTo(v: unknown, recordId: string): boolean {
  return Array.isArray(v) && v.some((x) => String(x) === recordId);
}

async function fromPostgres(ctx: OrgCtx): Promise<JobListView[]> {
  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { updatedAt: "desc" },
    include: { _count: { select: { conPhases: true, actions: true, conRisks: true } } },
  });
  return jobs.map((job) => ({
    id: String(job.id),
    name: job.name,
    code: job.code,
    engagementType: job.engagementType,
    address: job.address ?? "",
    suburb: job.suburb ?? "",
    status: job.status,
    completionPct: job.completionPct,
    healthScore: job.healthScore,
    budgetTotal: toNum(job.budgetTotal),
    rag: "", // Postgres phases carry no RAG (Airtable is system of record)
    phaseRags: [],
    counts: {
      phases: job._count.conPhases,
      actions: job._count.actions,
      risks: job._count.conRisks,
    },
  }));
}

// Rough progress for a list card when we don't scan the phase table (large
// orgs) — the detail page still shows exact phase-derived completion. Keyed on
// the matter status vocabulary; closed states are 100%, everything else a
// representative mid-point.
function completionFromStatus(status: string): number {
  const s = status.toLowerCase();
  if (s.startsWith("closed") || s === "complete" || s === "filled") return 100;
  if (s === "intake") return 5;
  if (s === "on hold") return 40;
  if (s === "in discovery") return 55;
  if (s === "in mediation") return 65;
  if (s === "awaiting court") return 75;
  return 45; // active / in progress / other
}

async function fromAirtable(ctx: OrgCtx): Promise<JobListView[]> {
  const jobRows = await core.list(ctx.orgSlug, "JOBS", { maxRecords: 200 });

  // For a data-rich org (thousands of matters → tens of thousands of phases),
  // scanning the whole PHASES/RISKS tables just to count per-job children is the
  // dominant cost (and is duplicated on the dashboard). Above a threshold we
  // read counts straight off each job's own link-field arrays and approximate
  // completion from status — no child-table scan. Smaller orgs keep the exact
  // phase-derived numbers (unchanged behaviour, cheap at that size).
  const big = jobRows.length > 300;
  const [phaseRows, riskRows] = big
    ? [[] as Record<string, unknown>[], [] as Record<string, unknown>[]]
    : await Promise.all([
        core.list(ctx.orgSlug, "PHASES", { maxRecords: 500 }),
        core.list(ctx.orgSlug, "RISKS", { maxRecords: 500 }),
      ]);

  return jobRows.map((job) => {
    const status = str(job["Status"]) || "open";
    let phaseCount: number;
    let riskCount: number;
    let completionPct: number;
    let phaseRags: string[] = [];
    if (big) {
      phaseCount = Array.isArray(job["PHASES"]) ? job["PHASES"].length : 0;
      riskCount = Array.isArray(job["RISKS"]) ? job["RISKS"].length : 0;
      completionPct = completionFromStatus(status);
    } else {
      const phases = phaseRows.filter((p) => linksTo(p["Job"], job.id) && p["Is_AI_Draft"] !== true);
      const openRisks = riskRows.filter(
        (r) => linksTo(r["Job"], job.id) && (str(r["Status"]) || "open") === "open",
      );
      phaseCount = phases.length;
      riskCount = openRisks.length;
      completionPct = phases.length
        ? Math.round(phases.reduce((s, p) => s + num(p["Completion_Pct"]), 0) / phases.length)
        : 0;
      phaseRags = phases.map((p) => normalizeRag(p["RAG"])).filter(Boolean);
    }
    return {
      id: job.id,
      name: str(job["Job_Name"]) || "(job)",
      code: "", // Airtable JOBS has no code field (see plan P4)
      // Tolerant read — the field lands via schema-drift migration (Spec 12 M5)
      engagementType: normalizeEngagementType(job["Engagement_Type"]) || "",
      address: "",
      suburb: "",
      status,
      completionPct,
      healthScore: 0, // not tracked in Airtable JOBS
      budgetTotal: num(job["Estimated_Value"]),
      rag: computeJobRag(phaseRags),
      phaseRags,
      counts: { phases: phaseCount, actions: 0, risks: riskCount },
    };
  });
}

export interface JobsPage {
  items: JobListView[];
  page: number;
  pageSize: number;
  hasNext: boolean;
}

/** Escape a user string for an Airtable double-quoted formula literal. */
function airStr(s: string): string {
  return `"${s.replace(/["\\]/g, "")}"`;
}

/** Map a raw Airtable JOBS record (fields keyed by name) to a JobListView.
 *  Counts come from the record's own link-field arrays and completion from
 *  status — no child-table reads (see fromAirtable's `big` path). */
function rawJobToView(rec: { id: string; fields: Record<string, unknown> }): JobListView {
  const f = rec.fields;
  const status = str(f["Status"]) || "open";
  return {
    id: rec.id,
    name: str(f["Job_Name"]) || "(job)",
    code: "",
    engagementType: normalizeEngagementType(f["Engagement_Type"]) || "",
    address: "",
    suburb: "",
    status,
    completionPct: completionFromStatus(status),
    healthScore: 0,
    budgetTotal: num(f["Estimated_Value"]),
    rag: "", // paged path reads no PHASES rows — no signal
    phaseRags: [],
    counts: {
      phases: Array.isArray(f["PHASES"]) ? f["PHASES"].length : 0,
      actions: 0,
      risks: Array.isArray(f["RISKS"]) ? f["RISKS"].length : 0,
    },
  };
}

/** True server-side pagination for the Airtable path — fetches only the
 *  requested page from Airtable (sort + optional text search pushed to the
 *  API), so a firm with thousands of matters renders a page in ~one request
 *  instead of pulling the whole table. Trade-off vs. loadJobsList: no exact
 *  total / per-status facets (Airtable can't count), and navigation is
 *  prev/next (a numbered pager would need the total). Used only for large orgs;
 *  smaller orgs keep the richer client-side loadJobsList path. */
export async function loadJobsPage(
  ctx: OrgCtx,
  opts: { page: number; pageSize: number; q?: string },
): Promise<JobsPage> {
  const page = Math.max(1, opts.page);
  const pageSize = Math.max(1, opts.pageSize);
  const baseId = await resolveBaseId(ctx.orgSlug);
  const q = (opts.q ?? "").trim();
  const filterByFormula = q
    ? `SEARCH(LOWER(${airStr(q)}), LOWER({Job_Name}&""))`
    : undefined;
  // Recent matters first — a sensible, cheap default the API can sort on.
  const sort = [{ field: "Date_Estimated", direction: "desc" as const }];

  // Page forward via the API cursor to reach the requested page. Shallow pages
  // (the demo norm) cost one request each; deep pages cost N. If the cursor runs
  // out before the target page, the requested page is past the end → empty.
  let offset: string | undefined;
  let records: { id: string; fields: Record<string, unknown> }[] = [];
  for (let i = 1; i <= page; i++) {
    const res = await listPage(baseId, "JOBS", { filterByFormula, sort, pageSize, offset });
    offset = res.offset;
    if (i === page) {
      records = res.records; // the requested page
      break;
    }
    if (!offset) break; // ran out before reaching the requested page → empty
  }
  return { items: records.map(rawJobToView), page, pageSize, hasNext: Boolean(offset) };
}

/** Load the projects list from whichever backend is active. Pass the viewer
 *  to apply RLS (governance §3): non-exempt roles see only the JOBS their
 *  TEAM record links to — unscoped until TEAM assignments exist (see rls.ts). */
export async function loadJobsList(
  ctx: OrgCtx,
  viewer?: { email: string; role: string },
): Promise<JobListView[]> {
  const jobs = await (airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx));
  if (!viewer) return jobs;
  // Canonical scope: exempt → all; otherwise assigned jobs ∪ the org's General
  // project, honouring the fail-open/closed enforce gate (see resolveJobScope).
  return scopeRows(jobs, (j) => j.id, await resolveJobScope(ctx, viewer));
}
