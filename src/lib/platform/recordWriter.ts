// Record writer with typecast (Platform Architecture doc utility layer).
// Every platform mutation goes through writeRecord: input is Zod-validated and
// type-coerced, orgId is force-stamped, and a PlatExecutionLog row is written.
// With requireApproval the write is NOT performed — a PlatPendingWrite
// proposal is queued instead, and executeProposal() performs the deferred
// write once a human approves it (proposals expire after 7 days). The
// execution log itself is append-only: workflow state lives on the pending
// row, audit events only ever get added.

import { z } from "zod";
import { airtableEnabled, core } from "@/lib/airtable";
import { airtableMapFor, toFields } from "@/lib/airtable/fieldMaps";
import { prisma } from "@/lib/db";
import { logger, errMeta } from "@/lib/logger";
import { Actor, OrgCtx } from "./types";
import { emitOutboundEvent } from "./outbox";
import { proposalJobId } from "./proposalSource";
import { reconcileAirtableWrite } from "./reconciliation";
import { enforceVocab, type VocabCoercion } from "./vocab";
import { canWrite } from "./roles";

// ── field helpers (typecast layer) ────────────────────────────────────

const id = z.union([z.coerce.number().int().positive(), z.string().trim().regex(/^rec[\w]+$/)]);
const optId = z.preprocess((v) => (v === "" || v == null ? undefined : v), id.optional());
const num = z.coerce.number();
const optNum = z.preprocess((v) => (v === "" || v == null ? undefined : v), num.optional());
const int = z.coerce.number().int();
const bool = z.preprocess(
  (v) => (typeof v === "string" ? ["true", "on", "1", "yes"].includes(v.toLowerCase()) : v),
  z.coerce.boolean(),
);
const date = z.coerce.date();
const optDate = z.preprocess((v) => (v === "" || v == null ? undefined : v), date.optional());
const str = (max: number) => z.string().trim().max(max);
const jsonStr = z
  .string()
  .refine((s) => {
    try {
      JSON.parse(s);
      return true;
    } catch {
      return false;
    }
  }, "must be valid JSON");

// ── table registry ────────────────────────────────────────────────────

interface TableDef {
  /** Physical table name recorded in the execution log. */
  physical: string;
  /** Prisma model delegate accessor. Omitted for Airtable-only Core tables
   *  (e.g. COMMS) that have no 1:1 Postgres model — those route exclusively
   *  through the field-map branch of performWrite, which never touches it. */
  delegate?: () => {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: number }>;
    findFirst: (args: { where: Record<string, unknown> }) => Promise<{ id: number } | null>;
    update: (args: {
      where: { id: number };
      data: Record<string, unknown>;
    }) => Promise<{ id: number }>;
    delete: (args: { where: { id: number } }) => Promise<unknown>;
  };
  create: z.ZodTypeAny;
  update: z.ZodTypeAny;
  /** Schema fields that exist only in Airtable (no Postgres column) — stripped
   *  before a Prisma write so the legacy path doesn't reject them. */
  pgOmit?: readonly string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const d = (m: any) => () => m as ReturnType<NonNullable<TableDef["delegate"]>>;

// Update schema = create schema with every field optional AND defaults
// stripped — otherwise a partial update would silently reset omitted fields
// to their create-time defaults.
function partialNoDefaults(obj: z.ZodObject<z.ZodRawShape>): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(obj.shape)) {
    let s: any = v;
    if (typeof s.removeDefault === "function") s = s.removeDefault();
    else if (s?.def?.type === "default" && typeof s.unwrap === "function") s = s.unwrap();
    shape[k] = (s as z.ZodTypeAny).optional();
  }
  return z.object(shape);
}
const upd = partialNoDefaults;
/* eslint-enable @typescript-eslint/no-explicit-any */

const actionSchema = z.object({
  jobId: optId,
  workstreamId: optId,
  title: str(300).min(1),
  detail: z.string().default(""),
  priority: z.enum(["P1", "P2", "P3"]).default("P2"),
  status: z.enum(["open", "in_progress", "done", "deferred"]).default("open"),
  // Spec 10 ISSUES classifier (Airtable Issue_Type single-select; typecast
  // reconciles the option). String, not enum, so ingestion/assistant writes
  // that omit or vary it don't fail validation.
  issueType: str(40).default("Open Action"),
  phaseId: optId,
  riskId: optId,
  owner: str(200).default(""),
  dueDate: optDate,
  sourceType: str(30).default("manual"),
  sourceId: optId,
  context: jsonStr.default("{}"),
});

// COMMS (Spec 10 Core) — the coordination layer: who gets told what, by when.
// Airtable-only (no Postgres model); routed through the field-map branch.
const commsSchema = z.object({
  jobId: optId,
  topic: str(300).min(1),
  messageType: z
    .enum(["Decision Notification", "Status Update", "Action Required", "Approval Request", "Escalation"])
    .default("Status Update"),
  stakeholderRole: z
    .enum(["Owner", "Builder", "Architect", "Broker", "Supplier", "Regulatory", "Other"])
    .default("Owner"),
  stakeholderId: optId,
  status: z.enum(["pending", "sent", "acknowledged", "overdue"]).default("pending"),
  dueDate: optDate,
  phaseId: optId,
  linkedIssueId: optId,
  linkedDecisionId: optId,
  sentBy: str(200).default(""),
  notes: z.string().default(""),
});

// PLAN (Spec 12 Core) — the Module 5 task-level schedule. Airtable-only (no
// Postgres model); routed through the field-map branch like COMMS. Status uses
// the canonical PLAN.Status vocabulary (vocab.ts) directly — string, not enum,
// so vocab enforcement (not validation) owns canonicalisation.
const planSchema = z.object({
  jobId: optId,
  name: str(300).min(1),
  phaseId: optId,
  status: str(30).default("Not Started"),
  rag: str(10).default(""),
  startDate: optDate,
  endDate: optDate,
  durationDays: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().int().min(0).optional(),
  ),
  assignedToId: optId,
  notes: z.string().default(""),
});

const decisionSchema = z.object({
  jobId: optId,
  description: z.string().trim().min(1),
  rationale: z.string().default(""),
  alternatives: z.string().default(""),
  category: str(100).default(""),
  status: z.enum(["proposed", "confirmed", "superseded"]).default("proposed"),
  madeBy: str(200).default(""),
  sourceType: str(30).default("manual"),
  sourceId: optId,
  decidedAt: optDate,
});

const workstreamSchema = z.object({
  jobId: optId,
  name: str(200).min(1),
  description: z.string().default(""),
  milestone: str(300).default(""),
  status: str(30).default("active"),
  notes: z.string().default(""),
});

const learningRuleSchema = z.object({
  ruleCode: str(20).min(1),
  kind: z.enum(["guidance", "adjustment"]).default("guidance"),
  description: z.string().trim().min(1),
  category: str(100).default(""),
  dimension: str(100).default(""),
  triggerCondition: jsonStr.default("{}"),
  adjustment: jsonStr.default("{}"),
  priority: int.default(0),
  confidence: int.min(0).max(100).default(50),
  isActive: bool.default(true),
  autoApply: bool.default(false),
  cannotOverride: bool.default(false),
  sourceHypothesisId: optId,
  notes: z.string().default(""),
  dateActivated: optDate,
});

const jobSchema = z.object({
  code: str(50).min(1),
  name: str(300).min(1),
  engagementType: z
    .enum(["short_job", "long_project", "ongoing", "seasonal"])
    .default("long_project"),
  status: str(30).default("intake"),
  clientContactId: optId,
  address: str(400).default(""),
  suburb: str(100).default(""),
  lat: optNum,
  lng: optNum,
  startDate: optDate,
  targetEndDate: optDate,
  completionPct: int.min(0).max(100).default(0),
  healthScore: int.min(0).max(100).default(50),
  budgetTotal: num.default(0),
  summary: z.string().default(""),
  meta: jsonStr.default("{}"),
});

const contactSchema = z.object({
  name: str(200).min(1),
  type: str(30).default("client"),
  role: str(100).default(""),
  email: str(254).default(""),
  phone: str(30).default(""),
  company: str(200).default(""),
  notes: z.string().default(""),
  isActive: bool.default(true),
});

const documentSchema = z.object({
  jobId: optId,
  title: str(300).min(1),
  kind: z.enum(["file", "link", "generated"]).default("file"),
  docType: str(50).default(""),
  classification: str(50).default(""),
  storageProvider: str(20).default("local"),
  storageRef: str(800).default(""),
  mimeType: str(100).default(""),
  sizeBytes: int.default(0),
  version: int.default(1),
  parentDocumentId: optId,
  textContent: z.string().default(""),
  aiSummary: z.string().default(""),
  aiAnalysis: jsonStr.default("{}"),
  confidence: z.preprocess(
    (v) => (v === "" || v == null ? undefined : v),
    z.coerce.number().min(0).max(100).optional(),
  ),
  status: str(30).default("uploaded"),
  uploadedBy: str(200).default(""),
  analyzedAt: optDate,
});

const phaseSchema = z.object({
  jobId: id,
  name: str(200).min(1),
  status: str(30).default("pending"),
  completionPct: int.min(0).max(100).default(0),
  sortOrder: int.default(0),
  startDate: optDate,
  endDate: optDate,
  isAiDraft: bool.default(false),
  approvedBy: str(200).default(""),
  evidenceSuggestion: jsonStr.default("{}"),
  // Spec 12 Module 5: RAG health signal (PG column added for the cascade
  // engine port; Airtable mirrors via PHASES.RAG). Empty/absent is never
  // written on the Airtable plane (fieldMap presence-gate).
  rag: str(10).default(""),
});

const phaseEvidenceSchema = z.object({
  jobId: id,
  phaseId: id,
  documentId: id,
  note: str(300).default(""),
  addedBy: str(200).default(""),
});

const budgetLineSchema = z.object({
  jobId: id,
  phaseId: optId,
  category: str(100).default(""),
  description: str(300).default(""),
  budgetAmount: num.default(0),
  committedAmount: num.default(0),
  actualAmount: num.default(0),
});

// CASHFLOWS (Spec 12) — per-transaction ledger. Postgres writes land in
// PlatConCashflowLedger (migration-plan Phase 2); the legacy monthly-shaped
// PlatConCashflow stays unwired, read-only for pre-ledger dev data. Keys
// match the ledger model columns 1:1 (delegate-branch invariant).
const cashflowSchema = z.object({
  jobId: id,
  name: str(200).default(""),
  period: z.string().regex(/^\d{4}-\d{2}$/, "period must be YYYY-MM"),
  type: z.enum(["In", "Out"]).default("Out"),
  amount: num.default(0),
  sourceOrPayee: str(200).default(""),
  category: str(100).default(""),
  status: z.enum(["Forecast", "Confirmed", "Paid", "Overdue"]).default("Forecast"),
  notes: z.string().default(""),
});

const riskSchema = z.object({
  jobId: id,
  description: z.string().trim().min(1),
  likelihood: int.min(1).max(5).default(3),
  impact: int.min(1).max(5).default(3),
  mitigation: z.string().default(""),
  // "materialised" triggers cascade rule G (auto-create the linked ISSUES row).
  status: z.enum(["open", "accepted", "mitigated", "closed", "materialised"]).default("open"),
  owner: str(200).default(""),
  escalatedAt: optDate,
  escalationNote: z.string().default(""),
  createdByAi: bool.default(false),
});

const variationSchema = z.object({
  jobId: id,
  refNumber: str(30).default(""),
  title: str(300).min(1),
  description: z.string().default(""),
  scopeChange: z.string().default(""),
  costImpact: num.default(0),
  timeImpactDays: int.default(0),
  status: z.enum(["draft", "submitted", "approved", "rejected"]).default("draft"),
  isAiDrafted: bool.default(false),
  aiDraft: jsonStr.default("{}"),
  submittedBy: str(200).default(""),
  approvedBy: str(200).default(""),
  approvedAt: optDate,
});

const vendorSchema = z.object({
  name: str(200).min(1),
  category: str(100).default(""),
  contactName: str(200).default(""),
  contactEmail: str(254).default(""),
  contactPhone: str(30).default(""),
  rating: int.min(1).max(10).default(5),
  notes: z.string().default(""),
  isActive: bool.default(true),
});

const procurementSchema = z.object({
  jobId: id,
  item: str(300).min(1),
  category: str(100).default(""),
  vendorId: optId,
  vendorName: str(200).default(""),
  qty: num.default(1),
  unitPrice: num.default(0),
  total: num.default(0),
  status: str(30).default("pending"),
  dueDate: optDate,
});

const roomSchema = z.object({
  jobId: id,
  zone: str(100).default(""),
  name: str(200).min(1),
  areaSqm: optNum,
  ceilingHeight: str(50).default(""),
  finishes: jsonStr.default("{}"),
  notes: z.string().default(""),
});

const minutesSchema = z.object({
  jobId: id,
  meetingDate: date,
  title: str(300).default(""),
  attendees: str(500).default(""),
  rawMinutes: z.string().min(1),
  extractedActions: jsonStr.default("[]"),
  actionsCount: int.default(0),
  status: str(30).default("raw"),
  confirmedAt: optDate,
});

const weeklyReportSchema = z.object({
  jobId: id,
  weekEnding: date,
  title: str(300).default(""),
  content: z.string().default(""),
  isAiGenerated: bool.default(false),
  status: z.enum(["draft", "approved", "sent"]).default("draft"),
  approvedBy: str(200).default(""),
  approvedAt: optDate,
  sentAt: optDate,
  documentId: optId,
});

const bimModelSchema = z.object({
  jobId: id,
  name: str(200).min(1),
  provider: str(30).default("bimx"),
  embedUrl: str(800).min(1),
  clientVisible: bool.default(false),
  addedBy: str(200).default(""),
  notes: z.string().default(""),
});

const quoteSchema = z.object({
  // Optional: a proposal exists before its project does (jobId backfilled on
  // acceptance). assessmentId records the source assessment for that handoff.
  jobId: optId,
  assessmentId: optId,
  refNumber: str(30).default(""),
  title: str(300).min(1),
  clientName: str(200).default(""),
  status: z.enum(["draft", "sent", "accepted", "rejected", "expired"]).default("draft"),
  gstRate: num.default(10),
  subtotal: num.default(0),
  gstAmount: num.default(0),
  total: num.default(0),
  notes: z.string().default(""),
  validUntil: optDate,
  isAiDrafted: bool.default(false),
  createdBy: str(200).default(""),
  sentAt: optDate,
  decidedAt: optDate,
});

const quoteLineSchema = z.object({
  quoteId: id,
  description: str(300).min(1),
  category: str(100).default(""),
  qty: num.default(1),
  unit: str(20).default("item"),
  unitPrice: num.default(0),
  lineTotal: num.default(0),
  sortOrder: int.default(0),
});

const portalTokenSchema = z.object({
  jobId: id,
  token: z.string().trim().min(32).max(64),
  label: str(200).default(""),
  isActive: bool.default(true),
  viewsCount: int.default(0),
  expiresAt: optDate,
});

const REGISTRY = {
  job: { physical: "plat_core_job", delegate: d(prisma.platJob), create: jobSchema, update: upd(jobSchema) },
  contact: { physical: "plat_core_contact", delegate: d(prisma.platContact), create: contactSchema, update: upd(contactSchema) },
  workstream: { physical: "plat_core_workstream", delegate: d(prisma.platWorkstream), create: workstreamSchema, update: upd(workstreamSchema) },
  action: { physical: "plat_core_actionhub", delegate: d(prisma.platActionHub), create: actionSchema, update: upd(actionSchema) },
  decision: { physical: "plat_core_decision", delegate: d(prisma.platDecision), create: decisionSchema, update: upd(decisionSchema) },
  // Phase D: comms/plan gained Postgres mirrors (PlatComms/PlatConPlanTask,
  // Phase B) — the zod keys match the model columns 1:1, so the standard
  // delegate branch serves them when this org is on Postgres.
  comms: { physical: "COMMS", delegate: d(prisma.platComms), create: commsSchema, update: upd(commsSchema) },
  plan: { physical: "PLAN", delegate: d(prisma.platConPlanTask), create: planSchema, update: upd(planSchema) },
  learning_rule: { physical: "plat_core_learningrule", delegate: d(prisma.platLearningRule), create: learningRuleSchema, update: upd(learningRuleSchema) },
  document: { physical: "plat_core_document", delegate: d(prisma.platDocument), create: documentSchema, update: upd(documentSchema) },
  phase: { physical: "plat_con_phase", delegate: d(prisma.platConPhase), create: phaseSchema, update: upd(phaseSchema) },
  phase_evidence: { physical: "plat_con_phaseevidence", delegate: d(prisma.platConPhaseEvidence), create: phaseEvidenceSchema, update: upd(phaseEvidenceSchema) },
  budget_line: { physical: "plat_con_budgetline", delegate: d(prisma.platConBudgetLine), create: budgetLineSchema, update: upd(budgetLineSchema) },
  cashflow: { physical: "plat_con_cashflowledger", delegate: d(prisma.platConCashflowLedger), create: cashflowSchema, update: upd(cashflowSchema) },
  risk: { physical: "plat_con_risk", delegate: d(prisma.platConRisk), create: riskSchema, update: upd(riskSchema) },
  variation_order: { physical: "plat_con_variationorder", delegate: d(prisma.platConVariationOrder), create: variationSchema, update: upd(variationSchema) },
  vendor: { physical: "plat_con_vendor", delegate: d(prisma.platConVendor), create: vendorSchema, update: upd(vendorSchema) },
  procurement: { physical: "plat_con_procurement", delegate: d(prisma.platConProcurement), create: procurementSchema, update: upd(procurementSchema) },
  room: { physical: "plat_con_roommatrix", delegate: d(prisma.platConRoomMatrix), create: roomSchema, update: upd(roomSchema) },
  meeting_minutes: { physical: "plat_con_meetingminutes", delegate: d(prisma.platConMeetingMinutes), create: minutesSchema, update: upd(minutesSchema) },
  weekly_report: { physical: "plat_con_weeklyreport", delegate: d(prisma.platConWeeklyReport), create: weeklyReportSchema, update: upd(weeklyReportSchema) },
  bim_model: { physical: "plat_con_bimmodel", delegate: d(prisma.platConBimModel), create: bimModelSchema, update: upd(bimModelSchema) },
  portal_token: { physical: "plat_con_portaltoken", delegate: d(prisma.platConPortalToken), create: portalTokenSchema, update: upd(portalTokenSchema) },
  quote: { physical: "plat_con_quote", delegate: d(prisma.platConQuote), create: quoteSchema, update: upd(quoteSchema) },
  quote_line: { physical: "plat_con_quoteline", delegate: d(prisma.platConQuoteLine), create: quoteLineSchema, update: upd(quoteLineSchema) },
} satisfies Record<string, TableDef>;

export type WritableTable = keyof typeof REGISTRY;

export const WRITABLE_TABLES = Object.keys(REGISTRY) as WritableTable[];

export function isWritableTable(table: string): table is WritableTable {
  return table in REGISTRY;
}

/** Current state of an org-scoped record in a writable table — used by the
 *  approvals inbox to render before→after diffs. Null if absent. The findFirst
 *  carries orgId, so the tenancy guard is satisfied. */
export async function readRecord(
  ctx: OrgCtx,
  table: WritableTable,
  recordId: number | string,
): Promise<Record<string, unknown> | null> {
  const map = airtableEnabled(ctx) ? airtableMapFor(table) : undefined;
  if (map && typeof recordId === "string") {
    try {
      return await core.get(ctx.orgSlug, map.table, recordId);
    } catch {
      return null;
    }
  }
  const def: TableDef = REGISTRY[table];
  if (!def.delegate) return null; // Airtable-only table read via a numeric id — n/a
  const row = await def.delegate().findFirst({
    where: { id: Number(recordId), orgId: ctx.orgId },
  });
  return (row as Record<string, unknown> | null) ?? null;
}

// ── write API ─────────────────────────────────────────────────────────

/** A record identity: a Postgres integer id, or an Airtable "rec…" string id
 *  when AIRTABLE_MIGRATION is on. Threaded through the service layer so a
 *  parent id can be passed as a child's linked-record reference. */
export type RecordId = number | string;

/** Parse a form-supplied id into a RecordId: an Airtable "rec…" id stays a
 *  string, a numeric id (Postgres) coerces to a number. Returns null if blank.
 *  Detail-page forms post whichever id the active backend produced, so actions
 *  must accept both rather than Number()-coercing (which would NaN a rec id). */
export function recordIdParam(v: FormDataEntryValue | null): RecordId | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return null;
  return /^\d+$/.test(s) ? Number(s) : s;
}

export interface WriteRequest {
  table: WritableTable;
  op: "create" | "update" | "delete";
  /** Required for update/delete. Postgres ids are numbers; Airtable ids are
   *  "rec…" strings. */
  recordId?: RecordId;
  data?: unknown;
  actor: Actor;
  /** Persist a proposal instead of writing; executeProposal() completes it. */
  requireApproval?: boolean;
  /** One-line reason for the change (Spec 12 Module 7: the confirmation card
   *  shows the proposer's rationale). Stored as __rationale in the proposal
   *  payload and stripped before the write executes. */
  rationale?: string;
}

export interface WriteResult {
  status: "executed" | "proposed";
  recordId?: RecordId;
  /** Audit row id (executed writes). */
  execLogId?: number;
  /** Approval-queue row id (proposed writes). */
  proposalId?: RecordId;
}

/** Proposals not resolved within this window expire (stale data risk). */
const PROPOSAL_TTL_DAYS = 7;

function validated(def: TableDef, op: WriteRequest["op"], data: unknown): Record<string, unknown> {
  if (op === "delete") return {};
  const schema = op === "create" ? def.create : def.update;
  return schema.parse(data ?? {}) as Record<string, unknown>;
}

function isImmutableSnapshot(aiAnalysisRaw: unknown): boolean {
  if (typeof aiAnalysisRaw !== "string" || !aiAnalysisRaw.trim()) return false;
  try {
    const parsed = JSON.parse(aiAnalysisRaw) as { module4?: { immutableSnapshot?: boolean } };
    return parsed.module4?.immutableSnapshot === true;
  } catch {
    return false;
  }
}

/** Validate + typecast without writing — used by forms and unit tests. */
export function validateRecord(
  table: WritableTable,
  op: "create" | "update",
  data: unknown,
): Record<string, unknown> {
  return validated(REGISTRY[table], op, data);
}

async function performWrite(
  ctx: OrgCtx,
  table: WritableTable,
  def: TableDef,
  op: WriteRequest["op"],
  recordId: number | string | undefined,
  data: Record<string, unknown>,
): Promise<number | string | undefined> {
  // Airtable as system of record: route to the org's base when the flag is on
  // and the table has a field map. Tenancy is structural (the base is the org),
  // so there is no orgId guard here — base resolution derives from ctx.orgSlug.
  const map = airtableEnabled(ctx) ? airtableMapFor(table) : undefined;
  if (map) {
    if (op === "create") {
      // Learning-rule codes are allocated at write time (mirrors the Postgres
      // branch); "AUTO" from the assistant executor becomes a real LRN-#### so
      // the rule's Instance isn't the literal "AUTO".
      let payload = data;
      if (table === "learning_rule" && (data.ruleCode === "AUTO" || !data.ruleCode)) {
        const { nextRuleCode } = await import("@/services/platform/learning");
        payload = { ...data, ruleCode: await nextRuleCode(ctx) };
      }
      const fields = toFields(map, payload, "create");
      logVocabCoercions(ctx, map.table, enforceVocab(map.table, fields));
      const rec = await core.create(ctx.orgSlug, map.table, fields);
      return rec.id;
    }
    if (recordId == null) throw new Error(`${op} requires recordId`);
    const rid = String(recordId);
    if (op === "update") {
      const fields = toFields(map, data, "update");
      logVocabCoercions(ctx, map.table, enforceVocab(map.table, fields));
      await core.update(ctx.orgSlug, map.table, rid, fields);
      return rid;
    }
    await core.remove(ctx.orgSlug, map.table, [rid]);
    return rid;
  }

  if (!def.delegate) {
    throw new Error(
      `${table} is Airtable-only (no Postgres model); set AIRTABLE_MIGRATION=true`,
    );
  }
  const delegate = def.delegate();
  if (def.pgOmit) {
    data = Object.fromEntries(Object.entries(data).filter(([k]) => !def.pgOmit!.includes(k)));
  }
  if (op === "create") {
    // Learning-rule codes are allocated at WRITE time (deferred proposals
    // would otherwise collide on codes pre-allocated at propose time).
    if (def.physical === "plat_core_learningrule" && data.ruleCode === "AUTO") {
      const { createRuleWithCode } = await import("@/services/platform/learning");
      const { ruleCode: _auto, ...rest } = data;
      void _auto;
      const rule = await createRuleWithCode(ctx, rest as never);
      return rule.id;
    }
    const row = await delegate.create({ data: { ...data, orgId: ctx.orgId } });
    return row.id;
  }
  if (recordId == null) throw new Error(`${op} requires recordId`);
  const numId = Number(recordId);
  // Tenancy guard: the target row must belong to this org.
  const existing = await delegate.findFirst({ where: { id: numId, orgId: ctx.orgId } });
  if (!existing) throw new Error(`Record ${numId} not found in this organisation`);
  if (op === "update") {
    const row = await delegate.update({ where: { id: numId }, data });
    return row.id;
  }
  await delegate.delete({ where: { id: numId } });
  return numId;
}

/** actor.type → the EXECUTION_LOG.Initiated_By single-select (typecast on the
 *  client creates the option if missing). */
const INITIATED_BY: Record<Actor["type"], string> = {
  ai: "AI",
  human: "Owner",
  system: "System",
};

/** op → canonical EXECUTION_LOG.Action_Type (governance §5.3 — the lowercase
 *  op names were the "create"/"executed" pollution the §5.5 register retags). */
const AUDIT_ACTION_TYPE: Record<WriteRequest["op"], string> = {
  create: "Create",
  update: "Update",
  delete: "Delete",
};

/** Surface force-to-review coercions (§5.2 rule 3): warn-logged with full
 *  detail so off-vocabulary writes are visible instead of silently laundered. */
function logVocabCoercions(ctx: OrgCtx, table: string, coercions: VocabCoercion[]): void {
  if (!coercions.length) return;
  logger.warn("Vocab force-to-review applied", { orgId: ctx.orgId, table, coercions });
}

/** Append an "executed" audit row. The Postgres targetId column only holds
 *  integer ids; an Airtable "rec…" id is recorded in `result` instead. In
 *  Airtable mode the audit is best-effort — a Postgres outage must not undo a
 *  write that already landed in the system of record. */
async function writeExecutedLog(
  ctx: OrgCtx,
  args: {
    jobId: number | undefined;
    actor: Actor;
    op: WriteRequest["op"];
    physical: string;
    recordId: number | string | undefined;
    payload: string;
    bestEffort: boolean;
    approvedBy?: string;
    result?: string;
  },
): Promise<number | undefined> {
  const targetId = typeof args.recordId === "number" ? args.recordId : null;
  const ref = typeof args.recordId === "string" ? `airtable:${args.recordId}` : "";
  // Airtable system of record: the audit trail lives in the org's base
  // EXECUTION_LOG (so it survives a Postgres-free prod). Best-effort — a failed
  // audit must never undo a write that already landed.
  if (airtableEnabled(ctx)) {
    try {
      await core.create(ctx.orgSlug, "EXECUTION_LOG", {
        Log_Entry: `${args.op} ${args.physical}`.slice(0, 200),
        Action_Type: AUDIT_ACTION_TYPE[args.op],
        Tables_Affected: args.physical,
        Summary: args.result || args.payload,
        Initiated_By: INITIATED_BY[args.actor.type] ?? "System",
        Status: "Done",
        Date_Time: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn("Airtable execution-log write skipped", { orgId: ctx.orgId, ...errMeta(err) });
    }
    return undefined; // Airtable has no numeric audit id to thread
  }
  try {
    const log = await prisma.platExecutionLog.create({
      data: {
        orgId: ctx.orgId,
        jobId: args.jobId,
        actorType: args.actor.type,
        actorName: args.actor.name,
        operation: args.op,
        targetTable: args.physical,
        targetId,
        payload: args.payload,
        status: "executed",
        approvedBy: args.approvedBy ?? "",
        executedAt: new Date(),
        sourceMessageId: args.actor.sourceMessageId,
        result: args.result ?? ref,
      },
    });
    return log.id;
  } catch (err) {
    if (!args.bestEffort) throw err;
    logger.warn("Execution-log write skipped (Airtable mode)", { orgId: ctx.orgId, ...errMeta(err) });
    return undefined;
  }
}

/** The job a human write targets: the create payload's jobId, or the existing
 *  record's job for update/delete (Airtable "Job" link array, else the Postgres
 *  jobId scalar). null = org-global (no job) — always in scope. */
async function writeTargetJobId(ctx: OrgCtx, req: WriteRequest): Promise<string | null> {
  if (req.op === "create") {
    const j = (req.data as Record<string, unknown> | undefined)?.jobId;
    return j == null || j === "" ? null : String(j);
  }
  if (req.recordId == null) return null;
  const existing = await readRecord(ctx, req.table, req.recordId);
  if (!existing) return null;
  const link = existing["Job"];
  if (Array.isArray(link) && link.length > 0) return String(link[0]);
  const jid = existing["jobId"];
  return jid == null ? null : String(jid);
}

export async function writeRecord(ctx: OrgCtx, req: WriteRequest): Promise<WriteResult> {
  const def: TableDef = REGISTRY[req.table];
  // Governance §2.2 permission matrix, enforced at the single write choke
  // point for every human-initiated write (forms and direct actions). AI and
  // system writes are governed by the aiAuthority/approval flow instead, and
  // approvals are re-gated per table in the approvals actions.
  if (req.actor.type === "human") {
    const { getCurrentViewer } = await import("./org-context");
    const viewer = await getCurrentViewer(ctx);
    if (!canWrite(viewer.role, req.table, req.op)) {
      throw new Error(`Your role does not permit ${req.op} on ${req.table}.`);
    }
    // Project-level RLS (§3/§7): a scoped user may only write records that
    // belong to a job they're assigned to. No-op (`all`) for exempt roles and
    // until per-base TEAM assignments exist (fail-open) — see rls.ts.
    const { resolveJobScope, inScope } = await import("./rls");
    const scope = await resolveJobScope(ctx, viewer);
    if (scope.mode !== "all" && !inScope(scope, await writeTargetJobId(ctx, req))) {
      throw new Error(`Your project assignments do not permit ${req.op} on this ${req.table}.`);
    }
  }
  // Airtable mode skips the Postgres-shaped Zod schema (which would reject the
  // string record ids / missing numeric FKs of the Airtable world) and lets the
  // field map do its own coercion from the raw payload.
  const onAirtable = airtableEnabled(ctx) && airtableMapFor(req.table) !== undefined;
  const data = onAirtable
    ? ((req.data ?? {}) as Record<string, unknown>)
    : validated(def, req.op, req.data);
  const jobId = typeof data.jobId === "number" ? data.jobId : undefined;
  // The Postgres columns above are integer-only, but a proposal's Job_Id is a
  // text cell that must also hold an Airtable "rec…" id — otherwise every
  // Airtable-mode proposal stores a blank project and the approvals queue has
  // to recover it from the payload to scope correctly.
  const proposalJobId =
    data.jobId == null || data.jobId === "" ? undefined : String(data.jobId);
  // Postgres ids live in the Int column; Airtable "rec…" ids ride in the payload.
  // A numeric string (a Postgres id from a form) coerces to the Int column so
  // the audit trail keeps its numeric target in Postgres mode.
  const numRecordId =
    typeof req.recordId === "number"
      ? req.recordId
      : typeof req.recordId === "string" && /^\d+$/.test(req.recordId)
        ? Number(req.recordId)
        : null;
  const airRecordId =
    typeof req.recordId === "string" && req.recordId.startsWith("rec") ? req.recordId : undefined;

  if (req.table === "document" && req.op !== "create" && req.recordId != null) {
    const existing = await readRecord(ctx, "document", req.recordId);
    const immutable = isImmutableSnapshot(existing?.aiAnalysis ?? existing?.["AI_Analysis"]);
    if (immutable) {
      if (req.op === "delete") {
        throw new Error("Immutable snapshot documents cannot be deleted.");
      }
      const keys = Object.keys(data);
      const supersedeOnly = keys.length === 1 && data.status === "superseded";
      if (!supersedeOnly) {
        throw new Error(
          "Immutable snapshot documents cannot be edited. Create a new version instead.",
        );
      }
    }
  }

  // The reviewer-facing rationale rides in the payload (like __recId) so both
  // stores carry it without a column; executeProposal strips it pre-write.
  const rationaleMeta = req.rationale?.trim() ? { __rationale: req.rationale.trim() } : {};
  if (req.requireApproval) {
    if (airtableEnabled(ctx)) {
      const expiresAt = new Date(Date.now() + PROPOSAL_TTL_DAYS * 86_400_000).toISOString();
      const pending = await core.create(ctx.orgSlug, "PENDING_WRITES", {
        Table_Key: req.table,
        Op: req.op,
        Record_Id: req.recordId == null ? "" : String(req.recordId),
        Payload: JSON.stringify(
          airRecordId ? { __recId: airRecordId, ...rationaleMeta, ...data } : { ...rationaleMeta, ...data },
        ),
        Actor_Type: req.actor.type,
        Actor_Name: req.actor.name,
        Status: "proposed",
        Created_At: new Date().toISOString(),
        Expires_At: expiresAt,
        Job_Id: proposalJobId ?? "",
      });
      return { status: "proposed", proposalId: pending.id };
    }
    const pending = await prisma.platPendingWrite.create({
      data: {
        orgId: ctx.orgId,
        jobId,
        tableKey: req.table,
        op: req.op,
        recordId: numRecordId,
        payload: JSON.stringify(
          airRecordId ? { __recId: airRecordId, ...rationaleMeta, ...data } : { ...rationaleMeta, ...data },
        ),
        actorType: req.actor.type,
        actorName: req.actor.name,
        sourceMessageId: req.actor.sourceMessageId,
        status: "proposed",
        expiresAt: new Date(Date.now() + PROPOSAL_TTL_DAYS * 86_400_000),
      },
    });
    return { status: "proposed", proposalId: pending.id };
  }

  try {
    const recordId = await performWrite(ctx, req.table, def, req.op, req.recordId, data);
    // P2: auto-assign a new job's human creator to it, so they keep access under
    // project-RLS enforcement (docs/project-rls-activation.md). Best-effort —
    // never fails the write. Works on both stores: Airtable rec… ids and
    // Postgres numeric ids (PlatCtlAssignment.jobRecId holds either).
    if (req.table === "job" && req.op === "create" && req.actor.type === "human") {
      try {
        const { controlPlaneEnabled, addControlAssignment } = await import(
          "@/lib/platform/controlPlane"
        );
        if (controlPlaneEnabled() && recordId != null) {
          const { getCurrentViewer } = await import("./org-context");
          const viewer = await getCurrentViewer(ctx);
          if (viewer.email) await addControlAssignment(ctx.orgSlug, viewer.email, String(recordId));
        }
      } catch (e) {
        logger.warn("Auto-assign creator to new job failed", { orgId: ctx.orgId, ...errMeta(e) });
      }
    }
    const execLogId = await writeExecutedLog(ctx, {
      jobId,
      actor: req.actor,
      op: req.op,
      physical: def.physical,
      recordId,
      payload: JSON.stringify({ table: req.table, op: req.op, data }),
      bestEffort: onAirtable,
    });
    // Spec 12 Module 2 post-write reconciliation: every AI-initiated write is
    // re-read and diffed against the submitted payload (best-effort; never
    // fails the write). Human form writes are their own confirmation.
    if (req.actor.type !== "human" && (req.op === "create" || req.op === "update")) {
      await reconcileAirtableWrite(ctx, req.table, req.op, data, recordId, req.actor);
    }
    // Spec 12 Module 5 cascading update rules — third post-write hook (lock
    // plan §5.1). Dynamic import breaks the module cycle (the engine's write
    // effects call back into writeRecord); runCascades never throws and skips
    // system-actor writes, so cascade-on-cascade recursion is impossible.
    {
      const write = { table: req.table, op: req.op, data, actor: req.actor, recordId };
      const { runCascades } = await import("./cascade");
      await runCascades(ctx, write);
      // Spec 12 Module 6 job-close deltas (lock plan §6.2) — not owner-
      // toggleable like cascades; fires whenever a job closes. Never throws.
      if (req.table === "job") {
        const { handleJobCompletion } = await import("@/services/platform/closeJob");
        await handleJobCompletion(ctx, write);
      }
      // Spec 12 Module 7: the assistant's session context refreshes only when
      // the data may have changed — i.e. after any write (lock plan §7.1).
      const { invalidateAssistantContext } = await import("@/services/platform/assistant/context");
      invalidateAssistantContext(ctx.orgSlug);
    }
    return { status: "executed", recordId, execLogId };
  } catch (err) {
    logger.error("Record write failed", {
      orgId: ctx.orgId,
      table: req.table,
      op: req.op,
      recordId: req.recordId,
      ...errMeta(err),
    });
    await prisma.platExecutionLog
      .create({
        data: {
          orgId: ctx.orgId,
          jobId,
          actorType: req.actor.type,
          actorName: req.actor.name,
          operation: req.op,
          targetTable: def.physical,
          targetId: numRecordId,
          payload: JSON.stringify({ table: req.table, op: req.op, data }),
          status: "failed",
          error: String(err instanceof Error ? err.message : err).slice(0, 1000),
          sourceMessageId: req.actor.sourceMessageId,
        },
      })
      .catch(() => {});
    throw err;
  }
}

interface PendingProposal {
  id: RecordId;
  tableKey: string;
  op: string;
  recordId: number | null;
  payload: string;
  actorType: string;
  actorName: string;
  sourceMessageId: number | null;
  status: string;
  expiresAt: Date;
  /** Postgres Int id only — this feeds the execution-log's integer jobId
   *  column, so it stays null for an Airtable proposal. Use jobRef for
   *  anything that needs to know the project regardless of backend. */
  jobId: number | null;
  /** The proposal's project as an id of either backend ("rec…" or a numeric
   *  string). What outbound events carry, so a consumer can route on project
   *  — jobId alone is always null on Airtable, which is every real org. */
  jobRef: string | null;
}

// In-process claim registry: two concurrent resolutions of the same proposal
// (double-click that defeats the client guard, two tabs) would both read
// Status="proposed" and both execute — Airtable has no compare-and-set to stop
// them. Claiming here serializes resolution per proposal within an instance,
// which is the entire realistic race on a single-instance deployment. The
// Postgres path additionally does a true CAS claim (see executeProposal).
const inFlightProposals = new Set<string>();

function claimProposal(ctx: OrgCtx, proposalId: RecordId): () => void {
  const key = `${ctx.orgId}:${proposalId}`;
  if (inFlightProposals.has(key)) {
    throw new Error("Proposal is already being resolved — refresh to see its outcome.");
  }
  inFlightProposals.add(key);
  return () => inFlightProposals.delete(key);
}

async function resolvePending(ctx: OrgCtx, proposalId: RecordId): Promise<PendingProposal> {
  if (airtableEnabled(ctx)) {
    const row = await core.get(ctx.orgSlug, "PENDING_WRITES", String(proposalId));
    const status = typeof row["Status"] === "string" ? row["Status"] : "";
    if (status !== "proposed") throw new Error("Proposal not found (already resolved?)");
    const expiresAtRaw = typeof row["Expires_At"] === "string" ? row["Expires_At"] : "";
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : new Date(0);
    const payload = typeof row["Payload"] === "string" ? row["Payload"] : "{}";
    return {
      id: row.id,
      tableKey: typeof row["Table_Key"] === "string" ? row["Table_Key"] : "",
      op: typeof row["Op"] === "string" ? row["Op"] : "",
      recordId: null,
      payload,
      actorType: typeof row["Actor_Type"] === "string" ? row["Actor_Type"] : "system",
      actorName: typeof row["Actor_Name"] === "string" ? row["Actor_Name"] : "",
      sourceMessageId: null,
      status,
      expiresAt,
      // No numeric id exists in Airtable — but the project itself does, in the
      // Job_Id column (payload for proposals raised before it was persisted).
      jobId: null,
      jobRef: proposalJobId(row["Job_Id"], payload),
    };
  }
  const pending = await prisma.platPendingWrite.findFirst({
    where: { id: Number(proposalId), orgId: ctx.orgId, status: "proposed" },
  });
  if (!pending) throw new Error("Proposal not found (already resolved?)");
  return { ...pending, jobRef: proposalJobId(pending.jobId, pending.payload) };
}

/** Perform the deferred write behind a pending proposal. The execution log
 *  stays append-only: execution/rejection each ADD a row; only the pending
 *  row's workflow status mutates. */
export async function executeProposal(
  ctx: OrgCtx,
  proposalId: RecordId,
  approvedBy: string,
  /** Approve-with-edits (Spec 12 Module 2): field values the reviewer changed
   *  before approving, merged over the stored payload. The caller is
   *  responsible for emitting the matching CORRECTIONS records. */
  edits?: Record<string, unknown>,
): Promise<WriteResult> {
  const release = claimProposal(ctx, proposalId);
  try {
    return await executeProposalClaimed(ctx, proposalId, approvedBy, edits);
  } finally {
    release();
  }
}

async function executeProposalClaimed(
  ctx: OrgCtx,
  proposalId: RecordId,
  approvedBy: string,
  edits?: Record<string, unknown>,
): Promise<WriteResult> {
  const pending = await resolvePending(ctx, proposalId);

  if (!airtableEnabled(ctx)) {
    // Atomic claim across instances: only one resolver may move the row out of
    // "proposed". A second concurrent approval matches zero rows and bails
    // before performing the write.
    const claimed = await prisma.platPendingWrite.updateMany({
      where: { id: Number(pending.id), orgId: ctx.orgId, status: "proposed" },
      data: { status: "executing" },
    });
    if (claimed.count !== 1) throw new Error("Proposal not found (already resolved?)");
  }

  if (pending.expiresAt < new Date()) {
    if (airtableEnabled(ctx)) {
      await core.update(ctx.orgSlug, "PENDING_WRITES", String(pending.id), {
        Status: "expired",
        Resolved_By: approvedBy,
        Resolved_At: new Date().toISOString(),
      });
    } else {
      await prisma.platPendingWrite.update({
        where: { id: Number(pending.id) },
        data: { status: "expired", resolvedBy: approvedBy, resolvedAt: new Date() },
      });
    }
    throw new Error(
      `Proposal #${pending.id} expired on ${pending.expiresAt.toISOString().slice(0, 10)} — the underlying data may have changed. Ask the assistant to re-propose.`,
    );
  }

  const def: TableDef | undefined = REGISTRY[pending.tableKey as WritableTable];
  if (!def) throw new Error(`Unknown table in proposal: ${pending.tableKey}`);
  const op = pending.op as WriteRequest["op"];

  const onAirtable = airtableEnabled(ctx) && airtableMapFor(pending.tableKey) !== undefined;
  try {
    const payloadObj = {
      ...(JSON.parse(pending.payload) as Record<string, unknown>),
      ...(edits ?? {}),
    };
    // Reviewer-facing metadata only — never written to the record. Every "__"
    // key is proposal metadata by convention (__rationale, __source, …), so
    // strip them all; __recId is consumed a few lines below before it goes.
    for (const k of Object.keys(payloadObj)) {
      if (k.startsWith("__") && k !== "__recId") delete payloadObj[k];
    }
    // Airtable update/delete proposals stash their "rec…" target in the payload
    // (the Postgres recordId column is integer-only). Strip it before writing.
    let target: number | string | undefined = pending.recordId ?? undefined;
    let data: Record<string, unknown>;
    if (onAirtable) {
      if (typeof payloadObj.__recId === "string") target = payloadObj.__recId;
      const { __recId: _r, ...rest } = payloadObj;
      void _r;
      data = rest;
    } else {
      // Re-validate: the schema may have tightened since the proposal was
      // stored, and stored dates revive as ISO strings.
      data = validated(def, op, payloadObj);
    }
    const recordId = await performWrite(ctx, pending.tableKey as WritableTable, def, op, target, data);
    // Post-write reconciliation on approved proposals too — the reviewed value
    // was submitted; this catches drift between submission and storage.
    if (op !== "delete") {
      await reconcileAirtableWrite(ctx, pending.tableKey, op, data, recordId, {
        type: (pending.actorType as Actor["type"]) ?? "system",
        name: pending.actorName,
      });
    }
    const execLogId = await writeExecutedLog(ctx, {
      jobId: pending.jobId ?? undefined,
      actor: {
        type: (pending.actorType as Actor["type"]) ?? "system",
        name: pending.actorName,
        sourceMessageId: pending.sourceMessageId ?? undefined,
      },
      op,
      physical: def.physical,
      recordId,
      payload: pending.payload,
      bestEffort: onAirtable,
      approvedBy,
      result: `Deferred write approved (proposal #${pending.id})`,
    });
    if (airtableEnabled(ctx)) {
      await core.update(ctx.orgSlug, "PENDING_WRITES", String(pending.id), {
        Status: "executed",
        Resolved_By: approvedBy,
        Resolved_At: new Date().toISOString(),
      });
    } else {
      await prisma.platPendingWrite.update({
        where: { id: Number(pending.id) },
        data: { status: "executed", resolvedBy: approvedBy, resolvedAt: new Date(), execLogId },
      });
    }
    // Outbound event: an approved write is a confirmed domain change. Best-effort
    // + gated on an active outbound connection (no-op otherwise) — never throws.
    await emitOutboundEvent(ctx, `${pending.tableKey}.${op}`, {
      entityType: pending.tableKey,
      entityId: recordId,
      jobId: pending.jobRef ?? undefined,
      data: { approvedBy },
    });
    // Spec 12 Module 5 cascades fire on EXECUTION, not proposal — an approved
    // AI write is a confirmed domain change (same hook as the direct path).
    {
      const write = {
        table: pending.tableKey,
        op,
        data,
        actor: {
          type: (pending.actorType as Actor["type"]) ?? "system",
          name: pending.actorName,
        } as Actor,
        recordId,
      };
      const { runCascades } = await import("./cascade");
      await runCascades(ctx, write);
      if (pending.tableKey === "job") {
        const { handleJobCompletion } = await import("@/services/platform/closeJob");
        await handleJobCompletion(ctx, write);
      }
      const { invalidateAssistantContext } = await import("@/services/platform/assistant/context");
      invalidateAssistantContext(ctx.orgSlug);
    }
    return { status: "executed", recordId, execLogId, proposalId: pending.id };
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 1000);
    logger.error("Proposal execution failed", {
      orgId: ctx.orgId,
      proposalId: pending.id,
      table: pending.tableKey,
      op: pending.op,
      ...errMeta(err),
    });
    if (airtableEnabled(ctx)) {
      await core.update(ctx.orgSlug, "PENDING_WRITES", String(pending.id), {
        Status: "failed",
        Resolved_By: approvedBy,
        Resolved_At: new Date().toISOString(),
        Error: message,
      });
    } else {
      await prisma.platPendingWrite.update({
        where: { id: Number(pending.id) },
        data: { status: "failed", resolvedBy: approvedBy, resolvedAt: new Date(), error: message },
      });
    }
    throw err;
  }
}

/** Reject a pending proposal; the write is never performed. */
export async function rejectProposal(
  ctx: OrgCtx,
  proposalId: RecordId,
  rejectedBy: string,
  reason = "",
): Promise<void> {
  const release = claimProposal(ctx, proposalId);
  try {
    await rejectProposalClaimed(ctx, proposalId, rejectedBy, reason);
  } finally {
    release();
  }
}

async function rejectProposalClaimed(
  ctx: OrgCtx,
  proposalId: RecordId,
  rejectedBy: string,
  reason: string,
): Promise<void> {
  const pending = await resolvePending(ctx, proposalId);
  if (airtableEnabled(ctx)) {
    await core.update(ctx.orgSlug, "PENDING_WRITES", String(pending.id), {
      Status: "rejected",
      Resolved_By: rejectedBy,
      Resolved_At: new Date().toISOString(),
      Error: reason,
    });
    await core
      .create(ctx.orgSlug, "EXECUTION_LOG", {
        Log_Entry: `reject ${pending.tableKey}`.slice(0, 200),
        Action_Type: "reject",
        Tables_Affected: pending.tableKey,
        Summary: reason || `Proposal #${pending.id} rejected`,
        Initiated_By: "Owner",
        Status: "rejected",
        Date_Time: new Date().toISOString(),
      })
      .catch(() => {});
    return;
  }
  // Guarded on status so a reject racing an approval can't clobber an
  // already-executed proposal's terminal state.
  const rejected = await prisma.platPendingWrite.updateMany({
    where: { id: Number(pending.id), orgId: ctx.orgId, status: "proposed" },
    data: { status: "rejected", resolvedBy: rejectedBy, resolvedAt: new Date(), error: reason },
  });
  if (rejected.count !== 1) throw new Error("Proposal not found (already resolved?)");
  await prisma.platExecutionLog
    .create({
      data: {
        orgId: ctx.orgId,
        jobId: pending.jobId,
        actorType: "human",
        actorName: rejectedBy,
        operation: "reject",
        targetTable: REGISTRY[pending.tableKey as WritableTable]?.physical ?? pending.tableKey,
        payload: pending.payload,
        status: "rejected",
        executedAt: new Date(),
        sourceMessageId: pending.sourceMessageId,
        result: reason || `Proposal #${pending.id} rejected`,
      },
    })
    .catch(() => {});
}
