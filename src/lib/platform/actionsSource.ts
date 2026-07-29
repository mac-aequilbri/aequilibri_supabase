// Action Hub data source — Postgres (default) or the canonical Airtable
// ACTION_HUB table when AIRTABLE_MIGRATION is enabled. Returns a uniform view
// model + metrics so the page is identical regardless of backend. Same pattern
// as decisionsSource.ts.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import {
  ACTION_STATUSES,
  resolveActionStatus,
  suggestStatus,
  type AppStatus,
} from "./actionStatus";
import { loadActionStatusMap } from "./configSource";
import { loadJobLabelMap } from "./jobOptionsSource";
import { currentJobScope, recordInScope, scopeRows } from "./rls";
import {
  countEnumOptions,
  toPredicate,
  toPrismaWhere,
  type FacetCounts,
  type ListQuery,
  type ListViewConfig,
} from "./listQuery";
import type { OrgCtx } from "./types";

export interface ActionView {
  id: string;
  title: string;
  detail: string;
  jobCode: string | null;
  jobId: string | null;
  owner: string;
  dueDate: Date | null;
  priority: string;
  sourceType: string;
  /** Canonical status, or "unmapped" when the raw value isn't recognised. */
  status: string;
  /** The raw Airtable Status value, preserved for display/mapping. */
  rawStatus: string;
  /** True when the raw value has no known/ mapped canonical — flagged for cleanup. */
  needsMapping: boolean;
  /** Spec 10 ISSUES classifier (Airtable Issue_Type); "" on the Postgres path. */
  issueType: string;
}

/** A distinct unrecognised raw status + how many rows carry it + a suggested
 *  canonical status to prefill the mapping UI. */
export interface UnmappedStatus {
  raw: string;
  count: number;
  suggestion: AppStatus | null;
}

export interface ActionsData {
  items: ActionView[];
  metrics: { open: number; overdue: number; fromChat: number; needsMapping: number };
  unmapped: UnmappedStatus[];
  /** Unfiltered row count, so the FilterBar can show "12 of 214". */
  total: number;
  /** Per-option counts over the unfiltered list (Airtable path only). */
  facets?: FacetCounts;
}

/** Declarative filter config for the Action Hub — drives the FilterBar UI (via
 *  toClientConfig) and filtering on both backends. "unmapped" is a virtual
 *  status option matching by flag, and clean statuses exclude unmapped rows
 *  (getValue returns null for them), so the two never overlap. */
export const actionsListConfig: ListViewConfig<ActionView> = {
  search: [(a) => a.title, (a) => a.detail, (a) => a.owner, (a) => a.jobCode],
  prismaSearch: ["title", "detail", "owner"],
  fields: [
    {
      kind: "enum",
      name: "status",
      label: "Status",
      getValue: (a) => (a.needsMapping ? null : a.status),
      options: [
        ...ACTION_STATUSES.map((s) => ({ value: s as string, label: s.replace("_", " ") })),
        { value: "unmapped", match: (a: ActionView) => a.needsMapping },
      ],
    },
    {
      kind: "enum",
      name: "priority",
      label: "Priority",
      // Airtable stores raw option names ("High"); normalise before matching.
      // Postgres already stores P1/P2/P3, so the column filters directly.
      getValue: (a) => (a.priority && a.priority !== "—" ? appPriority(a.priority) : null),
      options: [
        { value: "P1", label: "P1 · high" },
        { value: "P2", label: "P2 · medium" },
        { value: "P3", label: "P3 · low" },
      ],
    },
    {
      kind: "daterange",
      name: "due",
      label: "Due",
      prismaField: "dueDate",
      getValue: (a) => a.dueDate,
    },
  ],
  sort: [
    { name: "due", label: "Due date", getValue: (a) => a.dueDate },
    { name: "title", label: "Title", getValue: (a) => a.title.toLowerCase() },
    {
      name: "priority",
      label: "Priority",
      getValue: (a) => (a.priority && a.priority !== "—" ? appPriority(a.priority) : null),
    },
  ],
  groups: [
    {
      name: "status",
      label: "Status",
      // Unmapped rows get their own bucket (the filter path hides them via null,
      // but for grouping a visible "unmapped" section is more useful).
      getValue: (a) => (a.needsMapping ? "unmapped" : a.status),
      options: [
        ...ACTION_STATUSES.map((s) => ({ value: s as string, label: s.replace("_", " ") })),
        { value: "unmapped", label: "unmapped" },
      ],
    },
    {
      name: "priority",
      label: "Priority",
      getValue: (a) => (a.priority && a.priority !== "—" ? appPriority(a.priority) : null),
      options: [
        { value: "P1", label: "P1 · high" },
        { value: "P2", label: "P2 · medium" },
        { value: "P3", label: "P3 · low" },
      ],
    },
    { name: "owner", label: "Owner", getValue: (a) => (a.owner && a.owner !== "—" ? a.owner : null) },
    { name: "issue", label: "Issue type", getValue: (a) => a.issueType || null },
    { name: "source", label: "Source", getValue: (a) => a.sourceType || null },
    { name: "project", label: "Project", getValue: (a) => a.jobCode || null },
  ],
  pageSize: 50,
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function firstLink(v: unknown): string | null {
  return Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
}

/** Airtable stores the owner text in Notes as "Owner: <name>" (the Assigned_To
 *  field is a linked record we can't set from a free-text name). Pull it back
 *  out so the edited owner is what the UI shows. */
function ownerFromNotes(notes: string): string {
  const m = notes.match(/Owner:\s*(.+)/i);
  return m ? m[1].split(/\r?\n/)[0].trim() : "";
}

/** Map a raw Airtable Priority option back to the app's P1/P2/P3 vocabulary so
 *  the edit form's select can default correctly. Postgres already stores P#. */
function appPriority(raw: string): string {
  const s = raw.trim();
  if (/^P[123]$/i.test(s)) return s.toUpperCase();
  const low = s.toLowerCase();
  if (low.startsWith("high") || low === "urgent") return "P1";
  if (low.startsWith("med") || low === "normal") return "P2";
  if (low.startsWith("low")) return "P3";
  return "P2";
}

/** A single action's editable fields, backend-agnostic. */
export interface ActionDetail {
  id: string;
  title: string;
  detail: string;
  owner: string;
  dueDate: Date | null;
  /** App priority (P1/P2/P3). */
  priority: string;
  /** Canonical app status (open/in_progress/done/deferred). */
  status: string;
  issueType: string;
  jobCode: string | null;
  jobId: string | null;
}

async function fromPostgres(ctx: OrgCtx, query?: ListQuery): Promise<ActionsData> {
  // RLS: scope the list AND the headline metrics to the viewer's assigned jobs
  // (Postgres path — the Airtable branch scopes via scopeRows). No-op for
  // whole-tenant viewers.
  const scope = await currentJobScope(ctx);
  const ids = scope.mode === "some" ? [...scope.jobIds].map(Number).filter((n) => Number.isFinite(n)) : null;
  const jobW = ids ? { jobId: { in: ids } } : scope.mode === "none" ? { jobId: -1 } : {};
  const where = {
    orgId: ctx.orgId,
    ...jobW,
    ...(query ? toPrismaWhere(query, actionsListConfig) : {}),
  };
  const [items, total, open, overdue, fromChat] = await Promise.all([
    db(ctx).platActionHub.findMany({
      where,
      orderBy: [{ status: "asc" }, { dueDate: "asc" }],
      take: 2000, // must exceed any real register size — pagination slices in-memory after this
      include: { job: { select: { code: true } } },
    }),
    db(ctx).platActionHub.count({ where: { orgId: ctx.orgId, ...jobW } }),
    db(ctx).platActionHub.count({
      where: { orgId: ctx.orgId, ...jobW, status: { in: ["open", "in_progress"] } },
    }),
    db(ctx).platActionHub.count({
      where: {
        orgId: ctx.orgId,
        ...jobW,
        status: { in: ["open", "in_progress"] },
        dueDate: { lt: new Date() },
      },
    }),
    db(ctx).platActionHub.count({ where: { orgId: ctx.orgId, ...jobW, sourceType: "chat" } }),
  ]);
  return {
    items: items.map((a) => ({
      id: String(a.id),
      title: a.title,
      detail: a.detail,
      jobCode: a.job?.code ?? null,
      jobId: a.jobId != null ? String(a.jobId) : null,
      owner: a.owner,
      dueDate: a.dueDate,
      priority: a.priority,
      sourceType: a.sourceType,
      status: a.status,
      rawStatus: a.status, // Postgres statuses are already canonical
      needsMapping: false,
      issueType: "", // no Postgres column — Issue_Type is an Airtable-only field
    })),
    metrics: { open, overdue, fromChat, needsMapping: 0 },
    unmapped: [],
    total,
    // No facet counts on Postgres — computing them would cost extra count
    // queries per option; the FilterBar simply omits counts when absent.
  };
}

async function fromAirtable(ctx: OrgCtx, query?: ListQuery): Promise<ActionsData> {
  const [rows, orgMap, jobLabels] = await Promise.all([
    core.list(ctx.orgSlug, "ISSUES", { maxRecords: 1000 }),
    loadActionStatusMap(ctx),
    loadJobLabelMap(ctx),
  ]);
  const now = Date.now();
  const unscoped: ActionView[] = rows.map((r) => {
    const raw = str(r["Status"]);
    const res = resolveActionStatus(raw, orgMap);
    const due = str(r["Due_Date"]);
    const owner = r["Assigned_To"];
    const notesOwner = ownerFromNotes(str(r["Notes"]));
    const jobRec = firstLink(r["Job"]);
    return {
      id: r.id,
      title: str(r["Action_Name"]) || "(untitled action)",
      detail: str(r["Description"]),
      jobCode: jobRec ? (jobLabels.get(jobRec) ?? null) : null,
      jobId: jobRec,
      owner: notesOwner || (Array.isArray(owner) && owner.length > 0 ? "(linked)" : "—"),
      dueDate: due ? new Date(due) : null,
      priority: str(r["Priority"]) || "—",
      sourceType: "airtable",
      status: res.canonical ?? "unmapped",
      rawStatus: raw,
      needsMapping: !res.clean,
      issueType: str(r["Issue_Type"]),
    };
  });
  // RLS: scope to the viewer's assigned jobs before metrics/facets so counts
  // reflect only what they can see (no-op `all` until TEAM assignments exist).
  const all = scopeRows(unscoped, (a) => a.jobId, await currentJobScope(ctx));
  // Only cleanly-resolved rows feed the headline metrics — unmapped values are
  // NOT guessed into "open" (that was the old bug); they surface separately so
  // the user can map them and the count stays trustworthy.
  const isOpen = (a: ActionView) =>
    !a.needsMapping && (a.status === "open" || a.status === "in_progress");
  const metrics = {
    open: all.filter(isOpen).length,
    overdue: all.filter((a) => isOpen(a) && a.dueDate !== null && a.dueDate.getTime() < now).length,
    fromChat: 0, // Airtable ACTION_HUB has no source channel
    needsMapping: all.filter((a) => a.needsMapping).length,
  };
  // Distinct non-blank unmapped raw values, most-common first, with a suggestion.
  const byRaw = new Map<string, number>();
  for (const a of all) {
    if (a.needsMapping && a.rawStatus.trim()) byRaw.set(a.rawStatus, (byRaw.get(a.rawStatus) ?? 0) + 1);
  }
  const unmapped: UnmappedStatus[] = [...byRaw.entries()]
    .map(([raw, count]) => ({ raw, count, suggestion: suggestStatus(raw) }))
    .sort((a, b) => b.count - a.count);

  return {
    // Filtering happens here, AFTER the TTL-cached core.list read — toggling
    // filters re-slices the cached snapshot instead of adding Airtable calls.
    items: query ? all.filter(toPredicate(query, actionsListConfig)) : all,
    metrics,
    unmapped,
    total: all.length,
    facets: countEnumOptions(all, actionsListConfig),
  };
}

/** Load actions + headline metrics from whichever backend is active. */
export function loadActions(ctx: OrgCtx, query?: ListQuery): Promise<ActionsData> {
  return airtableEnabled(ctx) ? fromAirtable(ctx, query) : fromPostgres(ctx, query);
}

/** Load a single action for the edit page. Null if it doesn't exist in this org. */
export async function loadAction(ctx: OrgCtx, id: string): Promise<ActionDetail | null> {
  if (airtableEnabled(ctx)) {
    let r: Record<string, unknown> | null = null;
    try {
      r = await core.get(ctx.orgSlug, "ISSUES", id);
    } catch {
      return null;
    }
    if (!r) return null;
    if (!(await recordInScope(ctx, r))) return null;
    const orgMap = await loadActionStatusMap(ctx);
    const res = resolveActionStatus(str(r["Status"]), orgMap);
    const due = str(r["Due_Date"]);
    return {
      id: str(r.id) || id,
      title: str(r["Action_Name"]) || "(untitled action)",
      detail: str(r["Description"]),
      owner: ownerFromNotes(str(r["Notes"])),
      dueDate: due ? new Date(due) : null,
      priority: appPriority(str(r["Priority"])),
      status: res.canonical ?? "open",
      issueType: str(r["Issue_Type"]),
      jobCode: null,
      jobId: firstLink(r["Job"]),
    };
  }
  const a = await db(ctx).platActionHub.findFirst({
    where: { id: Number(id), orgId: ctx.orgId },
    include: { job: { select: { code: true } } },
  });
  if (!a) return null;
  if (!(await recordInScope(ctx, a))) return null;
  return {
    id: String(a.id),
    title: a.title,
    detail: a.detail,
    owner: a.owner,
    dueDate: a.dueDate,
    priority: a.priority,
    status: a.status,
    issueType: "",
    jobCode: a.job?.code ?? null,
    jobId: a.jobId != null ? String(a.jobId) : null,
  };
}
