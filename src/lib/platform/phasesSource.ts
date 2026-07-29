// Phases data source — Postgres (default) or Airtable when the flag is on.
// Grouped per job (PHASES rows' Job link resolved against JOBS). The Airtable
// PHASES table has no evidence link or AI-suggestion field, so the evidence
// count is 0 and the suggestion is empty in that mode — the evidence/AI-vision
// workflow stays Postgres-only (its actions no-op against Airtable string ids).

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { recordInScope, scopeByJob } from "./rls";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface PhaseView {
  id: string;
  name: string;
  status: string;
  completionPct: number;
  isAiDraft: boolean;
  jobId: string;
  evidenceSuggestion: string;
  _count: { evidence: number };
  // Spec 12 Module 5 phase fields (Phase RAG board). RAG is the stored health
  // signal; "" when unset. phaseType/loopPermitted describe linear-vs-cyclical
  // engagement shape. sequence orders the lifecycle; openIssues counts linked
  // ISSUES. Populated in Airtable mode; defaulted in Postgres mode.
  rag: string;
  phaseType: string;
  loopPermitted: boolean;
  sequence: number;
  startDate: string | null;
  endDate: string | null;
  openIssues: number;
}

/** Canonical RAG label from a stored cell (tolerant of case / G-A-R shorthand). */
export function normalizeRag(v: unknown): string {
  const s = (typeof v === "string" ? v : "").trim().toLowerCase();
  if (s.startsWith("r")) return "Red";
  if (s.startsWith("a")) return "Amber";
  if (s.startsWith("g")) return "Green";
  return "";
}

export interface JobPhases {
  id: string;
  name: string;
  code: string;
  conPhases: PhaseView[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

async function fromPostgres(ctx: OrgCtx): Promise<JobPhases[]> {
  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { code: "asc" },
    include: {
      conPhases: {
        orderBy: { sortOrder: "asc" },
        include: { _count: { select: { evidence: true } } },
      },
    },
  });
  return jobs.map((j) => ({
    id: String(j.id),
    name: j.name,
    code: j.code,
    conPhases: j.conPhases.map((p) => ({
      id: String(p.id),
      name: p.name,
      status: p.status,
      completionPct: p.completionPct,
      isAiDraft: p.isAiDraft,
      jobId: String(p.jobId),
      evidenceSuggestion: p.evidenceSuggestion,
      _count: { evidence: p._count.evidence },
      // Postgres model has no RAG/type/loop columns (Airtable is system of
      // record for these); dates come from the model, the rest default.
      rag: "",
      phaseType: "",
      loopPermitted: false,
      sequence: p.sortOrder,
      startDate: p.startDate ? p.startDate.toISOString().slice(0, 10) : null,
      endDate: p.endDate ? p.endDate.toISOString().slice(0, 10) : null,
      openIssues: 0,
    })),
  }));
}

async function fromAirtable(ctx: OrgCtx): Promise<JobPhases[]> {
  const [jobRows, pRows] = await Promise.all([
    core.list(ctx.orgSlug, "JOBS", { maxRecords: 200 }),
    core.list(ctx.orgSlug, "PHASES", { maxRecords: 500 }),
  ]);
  const byJob = new Map<string, PhaseView[]>();
  for (const p of pRows) {
    const link = p["Job"];
    const key = Array.isArray(link) && link.length > 0 ? String(link[0]) : "_unassigned";
    const issues = p["ISSUES"];
    const sequence = num(p["Sequence"]) || num(p["Sort_Order"]);
    const row: PhaseView = {
      id: p.id,
      name: str(p["Phase_Name"]) || "(phase)",
      status: str(p["Status"]) || "pending",
      completionPct: num(p["Completion_Pct"]),
      isAiDraft: p["Is_AI_Draft"] === true,
      jobId: key,
      evidenceSuggestion: "{}",
      _count: { evidence: 0 },
      rag: normalizeRag(p["RAG"]),
      phaseType: str(p["Phase_Type"]),
      loopPermitted: p["Loop_Permitted"] === true,
      sequence,
      startDate: str(p["Start_Date"]) || null,
      endDate: str(p["End_Date"]) || null,
      openIssues: Array.isArray(issues) ? issues.length : 0,
    };
    (byJob.get(key) ?? byJob.set(key, []).get(key)!).push(row);
  }
  // Order each job's phases by lifecycle sequence (spec: phases are sequenced).
  for (const list of byJob.values()) list.sort((a, b) => a.sequence - b.sequence);
  return jobRows.map((j) => ({
    id: j.id,
    name: str(j["Job_Name"]) || "(job)",
    code: "",
    conPhases: byJob.get(j.id) ?? [],
  }));
}

/** Load phases grouped by job from whichever backend is active — RLS-scoped to
 *  the viewer's assigned jobs (each entry is one job). */
export async function loadPhaseJobs(ctx: OrgCtx): Promise<JobPhases[]> {
  const jobs = await (airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx));
  return scopeByJob(ctx, jobs, (j) => j.id);
}

/** Form-ready values for a single phase's edit page. Null if not in this org.
 *  (Evidence / AI-suggestion workflow stays on the list page.) */
export async function loadPhaseDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  if (airtableEnabled(ctx)) {
    let p: Record<string, unknown> | null = null;
    try {
      p = await core.get(ctx.orgSlug, "PHASES", id);
    } catch {
      return null;
    }
    if (!p) return null;
    if (!(await recordInScope(ctx, p))) return null;
    return {
      name: str(p["Phase_Name"]),
      status: str(p["Status"]) || "pending",
      completionPct: num(p["Completion_Pct"]),
      sortOrder: num(p["Sort_Order"]),
    };
  }
  const p = await db(ctx).platConPhase.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!p) return null;
  if (!(await recordInScope(ctx, p))) return null;
  return {
    name: p.name,
    status: p.status,
    completionPct: p.completionPct,
    sortOrder: p.sortOrder,
  };
}
