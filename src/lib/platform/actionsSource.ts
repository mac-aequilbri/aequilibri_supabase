// Action Hub data source — Postgres. Returns a uniform view model + metrics.
// Same pattern as decisionsSource.ts.

import { db, prisma } from "@/lib/db";
import { ACTION_STATUSES, type AppStatus } from "./actionStatus";
import { currentJobScope, recordInScope } from "./rls";
import {
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
  /** Per-option counts over the unfiltered list (not computed on Postgres). */
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

/** Map a raw legacy Priority option back to the app's P1/P2/P3 vocabulary so
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
  // RLS: scope the list AND the headline metrics to the viewer's assigned jobs.
  // No-op for whole-tenant viewers.
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
      issueType: a.issueType,
    })),
    metrics: { open, overdue, fromChat, needsMapping: 0 },
    unmapped: [],
    total,
    // No facet counts on Postgres — computing them would cost extra count
    // queries per option; the FilterBar simply omits counts when absent.
  };
}

/** Load actions + headline metrics. */
export function loadActions(ctx: OrgCtx, query?: ListQuery): Promise<ActionsData> {
  return fromPostgres(ctx, query);
}

/** Load a single action for the edit page. Null if it doesn't exist in this org. */
export async function loadAction(ctx: OrgCtx, id: string): Promise<ActionDetail | null> {
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
