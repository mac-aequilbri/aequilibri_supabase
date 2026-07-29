// Risk register data source — Postgres (default) or the Airtable RISKS table
// (Domain Extension, created in the base) when AIRTABLE_MIGRATION is enabled.
// Status values (open/accepted/mitigated/closed) match the app's, so no
// remapping is needed. First Domain-tier page wired to Airtable.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { loadJobLabelMap } from "./jobOptionsSource";
import { recordInScope, scopeByJob } from "./rls";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface RiskView {
  id: string;
  description: string;
  jobCode: string | null;
  jobId: string | null;
  likelihood: number;
  impact: number;
  mitigation: string;
  status: string;
  owner: string;
  escalatedAt: Date | null;
  escalationNote: string;
  createdByAi: boolean;
  // Spec 12 Module 5 RISKS fields. Read-only this pass — populated in Airtable
  // mode once the base carries the fields (schema-drift provisions them);
  // empty on Postgres and on bases that have not yet been migrated.
  category: string;
  rag: string;
}

/** Canonical RAG label from a stored cell (tolerant of case / shorthand). */
function normalizeRag(v: unknown): string {
  const s = (typeof v === "string" ? v : "").trim().toLowerCase();
  if (s.startsWith("r")) return "Red";
  if (s.startsWith("a")) return "Amber";
  if (s.startsWith("g")) return "Green";
  return "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function firstLink(v: unknown): string | null {
  return Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
}

async function fromPostgres(ctx: OrgCtx): Promise<RiskView[]> {
  const risks = await db(ctx).platConRisk.findMany({
    where: { orgId: ctx.orgId },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: { job: { select: { code: true } } },
  });
  return risks.map((r) => ({
    id: String(r.id),
    description: r.description,
    jobCode: r.job?.code ?? null,
    jobId: r.jobId != null ? String(r.jobId) : null,
    likelihood: r.likelihood,
    impact: r.impact,
    mitigation: r.mitigation,
    status: r.status,
    owner: r.owner,
    escalatedAt: r.escalatedAt,
    escalationNote: r.escalationNote,
    createdByAi: r.createdByAi,
    category: "", // Postgres model has no category/rag columns
    rag: "",
  }));
}

async function fromAirtable(ctx: OrgCtx): Promise<RiskView[]> {
  // Opts shared with loadJobsList + loadOrgHighlights — one cached read/render.
  const [rows, jobLabels] = await Promise.all([
    core.list(ctx.orgSlug, "RISKS", { maxRecords: 500 }),
    loadJobLabelMap(ctx),
  ]);
  return rows.map((r) => {
    const esc = str(r["Escalated_At"]);
    const jobRec = firstLink(r["Job"]);
    return {
      id: r.id,
      description: str(r["Risk"]) || "(untitled risk)",
      jobCode: jobRec ? (jobLabels.get(jobRec) ?? null) : null,
      jobId: jobRec,
      likelihood: num(r["Likelihood"]) || 1,
      impact: num(r["Impact"]) || 1,
      mitigation: str(r["Mitigation"]),
      status: str(r["Status"]) || "open",
      owner: str(r["Owner"]),
      escalatedAt: esc ? new Date(esc) : null,
      escalationNote: str(r["Escalation_Note"]),
      createdByAi: r["Created_By_AI"] === true,
      category: str(r["Category"]),
      rag: normalizeRag(r["RAG"]),
    };
  });
}

/** Load the risk register from whichever backend is active. */
export async function loadRisks(ctx: OrgCtx): Promise<RiskView[]> {
  const rows = await (airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx));
  return scopeByJob(ctx, rows, (r) => r.jobId);
}

/** Form-ready values for a single risk's edit page. Null if not in this org. */
export async function loadRiskDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  if (airtableEnabled(ctx)) {
    let r: Record<string, unknown> | null = null;
    try {
      r = await core.get(ctx.orgSlug, "RISKS", id);
    } catch {
      return null;
    }
    if (!r) return null;
    if (!(await recordInScope(ctx, r))) return null;
    return {
      description: str(r["Risk"]),
      likelihood: num(r["Likelihood"]) || 3,
      impact: num(r["Impact"]) || 3,
      mitigation: str(r["Mitigation"]),
      owner: str(r["Owner"]),
      status: str(r["Status"]) || "open",
    };
  }
  const r = await db(ctx).platConRisk.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!r) return null;
  if (!(await recordInScope(ctx, r))) return null;
  return {
    description: r.description,
    likelihood: r.likelihood,
    impact: r.impact,
    mitigation: r.mitigation,
    owner: r.owner,
    status: r.status,
  };
}
