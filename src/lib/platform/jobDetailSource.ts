// Job detail data source — Postgres (default) or Airtable when the flag is on.
// Backs /app/[org]/projects/[id]. The page renders a uniform JobDetailView so
// the swap is invisible; loadJobDetail returns null when the job is absent
// (page → notFound()). This is the first DETAIL page wired onto Airtable: the
// id is a numeric PK in Postgres mode and an "rec…" record id in Airtable mode,
// which is exactly why the old page's Number(id) lookup 404s after acceptance.
//
// Airtable JOBS is leaner than PlatJob — it has no code/engagementType/address/
// healthScore, and ACTION_HUB has no Job link — so those degrade to empty/zero
// in Airtable mode (completionPct is derived from phases). Related rows are
// read from the canonical tables and filtered by their Job link, matching the
// list-page sources (budgetSource/phasesSource/risksSource).

import { airtableEnabled, core } from "@/lib/airtable";
import type { CoreRow } from "@/lib/airtable";
import type { CoreTableName } from "@/lib/airtable/schema.generated";
import { db, prisma } from "@/lib/db";
import { normalizeEngagementType } from "./engagementProfile";
import { computeJobRag } from "./jobRag";
import { normalizeRag } from "./phasesSource";
import { budgetActuals, loadProcurement } from "./procurementSource";
import { toNum } from "@/lib/format";
import type { OrgCtx } from "./types";

export interface JobPhaseRow {
  id: string;
  name: string;
  status: string;
  completionPct: number;
  /** Stored phase RAG ("" when unset / Postgres mode). */
  rag: string;
}
export interface JobRiskRow {
  id: string;
  description: string;
  likelihood: number;
  impact: number;
}
export interface JobActionRow {
  id: string;
  title: string;
  owner: string;
  dueDate: Date | null;
}

export interface JobDetailView {
  id: string;
  name: string;
  code: string;
  engagementType: string;
  address: string;
  suburb: string;
  completionPct: number;
  healthScore: number;
  /** Derived engagement RAG (Spec 12 Module 5 §7, jobRag.ts) — worst-of-phases;
   *  "" = no phase carries a RAG signal. */
  rag: string;
  summary: string;
  budget: number;
  actual: number;
  phases: JobPhaseRow[];
  risks: JobRiskRow[];
  actions: JobActionRow[];
  counts: { bimModels: number; documents: number; variations: number };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
/** Length of a linked-record cell (an array of rec ids), 0 if not a link. */
function linkCount(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}
/** Whether a linked-record cell points at the given record id. */
function linksTo(v: unknown, recordId: string): boolean {
  return Array.isArray(v) && v.some((x) => String(x) === recordId);
}

/** Rec ids in a linked-record cell (array of "rec…" strings), else []. */
function linkIds(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter((s) => s.startsWith("rec")) : [];
}

/** Fetch specific records by id via a RECORD_ID() formula — exact and robust
 *  (no name-matching), so a detail page reads only its matter's children
 *  instead of scanning the whole table. Empty id list → no query. */
async function listByIds(
  orgSlug: string,
  table: CoreTableName,
  ids: string[],
): Promise<CoreRow[]> {
  if (ids.length === 0) return [];
  const formula = `OR(${ids.map((id) => `RECORD_ID()='${id}'`).join(",")})`;
  return core.list(orgSlug, table, { filterByFormula: formula });
}

async function fromPostgres(ctx: OrgCtx, id: string): Promise<JobDetailView | null> {
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) return null;
  const job = await db(ctx).platJob.findFirst({
    where: { id: jobId, orgId: ctx.orgId },
    include: {
      conPhases: { where: { isAiDraft: false }, orderBy: { sortOrder: "asc" } },
      conRisks: { where: { status: "open" }, orderBy: { createdAt: "desc" }, take: 5 },
      actions: {
        where: { status: { in: ["open", "in_progress"] } },
        orderBy: { dueDate: "asc" },
        take: 5,
      },
      conBudgets: true,
      _count: { select: { conBimModels: true, documents: true, conVariations: true } },
    },
  });
  if (!job) return null;
  return {
    id: String(job.id),
    name: job.name,
    code: job.code,
    engagementType: job.engagementType,
    address: job.address ?? "",
    suburb: job.suburb ?? "",
    completionPct: job.completionPct,
    healthScore: job.healthScore,
    rag: "", // Postgres phases carry no RAG (Airtable is system of record)
    summary: job.summary ?? "",
    budget: job.conBudgets.reduce((s, b) => s + toNum(b.budgetAmount), 0),
    actual: job.conBudgets.reduce((s, b) => s + toNum(b.actualAmount), 0),
    phases: job.conPhases.map((p) => ({
      id: String(p.id),
      name: p.name,
      status: p.status,
      completionPct: p.completionPct,
      rag: "",
    })),
    risks: job.conRisks.map((r) => ({
      id: String(r.id),
      description: r.description,
      likelihood: r.likelihood,
      impact: r.impact,
    })),
    actions: job.actions.map((a) => ({
      id: String(a.id),
      title: a.title,
      owner: a.owner,
      dueDate: a.dueDate,
    })),
    counts: {
      bimModels: job._count.conBimModels,
      documents: job._count.documents,
      variations: job._count.conVariations,
    },
  };
}

async function fromAirtable(ctx: OrgCtx, id: string): Promise<JobDetailView | null> {
  if (!id.startsWith("rec")) return null;
  let job;
  try {
    job = await core.get(ctx.orgSlug, "JOBS", id);
  } catch {
    return null; // 404 / deleted / wrong-base → not found
  }

  // Read only THIS job's children — by their record ids, taken from the job's
  // own link fields — instead of scanning the whole table. Essential for orgs
  // with thousands of matters (a detail page reads ~a dozen rows, not 15k). The
  // in-memory linksTo() filter below stays as an exact guard.
  const [phaseRows, riskRows, budgetRows, procRows] = await Promise.all([
    listByIds(ctx.orgSlug, "PHASES", linkIds(job["PHASES"])),
    listByIds(ctx.orgSlug, "RISKS", linkIds(job["RISKS"])),
    listByIds(ctx.orgSlug, "BUDGET", linkIds(job["BUDGET"])),
    loadProcurement(ctx),
  ]);
  const actualsByBudget = budgetActuals(procRows); // BUDGET rec id → computed Actual

  const phases: JobPhaseRow[] = phaseRows
    .filter((p) => linksTo(p["Job"], id) && p["Is_AI_Draft"] !== true)
    .sort((a, b) => num(a["Sort_Order"]) - num(b["Sort_Order"]))
    .map((p) => ({
      id: p.id,
      name: str(p["Phase_Name"]) || "(phase)",
      status: str(p["Status"]) || "pending",
      completionPct: num(p["Completion_Pct"]),
      rag: normalizeRag(p["RAG"]),
    }));

  const risks: JobRiskRow[] = riskRows
    .filter((r) => linksTo(r["Job"], id) && (str(r["Status"]) || "open") === "open")
    .slice(0, 5)
    .map((r) => ({
      id: r.id,
      description: str(r["Risk"]) || "(untitled risk)",
      likelihood: num(r["Likelihood"]) || 1,
      impact: num(r["Impact"]) || 1,
    }));

  const jobBudget = budgetRows.filter((b) => linksTo(b["Job"], id));
  const budget = jobBudget.reduce((s, b) => s + num(b["Estimated"]), 0);
  const actual = jobBudget.reduce((s, b) => s + (actualsByBudget.get(b.id) ?? 0), 0);

  // No completion field on Airtable JOBS — derive from non-draft phases.
  const completionPct = phases.length
    ? Math.round(phases.reduce((s, p) => s + p.completionPct, 0) / phases.length)
    : 0;

  return {
    id: job.id,
    name: str(job["Job_Name"]) || "(job)",
    code: "", // Airtable JOBS has no code field (see plan P4)
    // Tolerant read — the field lands via schema-drift migration (Spec 12 M5)
    engagementType: normalizeEngagementType(job["Engagement_Type"]) || "",
    address: "",
    suburb: "",
    completionPct,
    healthScore: 0, // not tracked in Airtable JOBS
    // Engagement RAG derived from this job's phases (blocker escalation needs
    // an ISSUES read this page doesn't do — the dashboard variant includes it).
    rag: computeJobRag(phases.map((p) => p.rag)),
    summary: str(job["Estimated_Summary"]) || str(job["Description"]),
    budget,
    actual,
    phases,
    risks,
    actions: [], // ACTION_HUB has no Job link in Airtable — empty in this mode
    counts: {
      bimModels: linkCount(job["BIM_MODELS"]),
      documents: linkCount(job["DOCUMENTS"]), // JOBS↔DOCUMENTS link added in Spec 12 reconciliation
      // Spec 12: variations live in CHANGE_LOG. The link counts all change-log
      // entries for the job (the app only writes Change_Type="Variation" rows).
      variations: linkCount(job["CHANGE_LOG"]),
    },
  };
}

/** Load a single job's detail view from whichever backend is active. */
export function loadJobDetail(ctx: OrgCtx, id: string): Promise<JobDetailView | null> {
  return airtableEnabled(ctx) ? fromAirtable(ctx, id) : fromPostgres(ctx, id);
}
