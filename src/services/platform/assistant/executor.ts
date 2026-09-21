// Executes assistant tool calls. Reads run directly (org-scoped); writes go
// through recordWriter under the org's aiAuthority policy — executed
// immediately or queued as a PlatPendingWrite proposal for human approval.
// This is the step UC2/UC3 never had: tagged chat outputs become real
// database rows.

import { db } from "@/lib/db";
import type { ToolUse } from "@/lib/claude";
import {
  requiredCreateFields,
  writableFields,
  writeRecord,
  WritableTable,
  type RecordId,
} from "@/lib/platform/recordWriter";
import { Actor, AiAuthority, OrgCtx } from "@/lib/platform/types";
import { currentJobScope, resolveJobScope } from "@/lib/platform/rls";
import {
  PROPOSABLE_KEYS,
  resolveTable,
  TABLE_KEYS,
  tableCatalog,
  tableFields,
  WRITER_TABLE,
} from "./dataCatalog";
import { roleCanProposeOn, roleCanQueryTable, roleCanUseTool, type ToolPolicy } from "./tools";

/** An explicitly-identified viewer for RLS scoping and operator gating. When
 *  omitted, the request's Clerk viewer is resolved via currentJobScope /
 *  isPlatformAdmin; the MCP path MUST pass its session member — an MCP
 *  request has no Clerk context, so falling back to the request viewer would
 *  resolve the wrong identity (mcp-assistant-plan §1). */
export interface ScopedViewer {
  email: string;
  role: string;
  /** Platform-operator flag; substitutes for the Clerk-coupled
   *  isPlatformAdmin() check when a viewer is supplied. */
  platformAdmin?: boolean;
}

export interface ToolOutcome {
  toolName: string;
  ok: boolean;
  /** Sent back to the model as the tool_result content. */
  summary: string;
  status?: "executed" | "proposed";
  proposalId?: RecordId;
  recordId?: RecordId;
}

/** The aiAuthority policy matrix — exported so it can be tested directly. */
export function requiresApproval(authority: AiAuthority, risk: string): boolean {
  if (risk === "read") return false;
  if (authority === "auto_low_risk") return risk === "high_write";
  return true; // propose_only / approve_required
}

// ── Reads ────────────────────────────────────────────────────────────────────
// The read surface mirrors an Airtable MCP server (see dataCatalog.ts for why):
// every migrated table, every column, free-text search, arbitrary field
// filters, sorting and paging — with the row total always reported so a capped
// read is visibly capped instead of passing for the whole set.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** Columns the tenancy and RLS predicates are built from — never overridable
 *  by a tool argument (mcp-assistant-plan §1: orgId must never be acceptable
 *  as a tool parameter). */
const SCOPE_FIELDS = new Set(["orgId", "jobId", "id"]);
/** Long text (document bodies, raw minutes) is clipped per field so one wide
 *  row can't crowd out the rest of the answer. The clip is announced inline. */
const MAX_TEXT = 2000;

/** Round-trips Prisma scalars to JSON the model reads cleanly: BigInt →
 *  number, Date → ISO date, Decimal → number, long strings clipped. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.length > MAX_TEXT) {
    return `${value.slice(0, MAX_TEXT)}… [clipped, ${value.length} chars total — use get_record for the full value]`;
  }
  return value;
}

function serialize(payload: unknown): string {
  return JSON.stringify(payload, jsonReplacer);
}

/** Turn the model's `filters` argument into `where` clauses, dropping anything
 *  that isn't a real column of the table — and, critically, anything that would
 *  overwrite the tenancy/RLS predicates. A model-supplied `filters.orgId` or
 *  `filters.jobId` landing in `where` would step straight out of the tenant or
 *  the viewer's job scope (mcp-assistant-plan §1: orgId must never be
 *  acceptable as a tool parameter). Rejected names are reported back so the
 *  model corrects the call instead of silently reading unfiltered rows.
 *  Exported for the tenancy test — this is a security boundary, not a detail. */
export function buildFilters(
  table: string,
  raw: unknown,
): { accepted: Record<string, unknown>; rejected: string[] } {
  const accepted: Record<string, unknown> = {};
  const rejected: string[] = [];
  const t = resolveTable(table);
  if (!t || !raw || typeof raw !== "object" || Array.isArray(raw)) return { accepted, rejected };
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    if (SCOPE_FIELDS.has(field) || !t.fieldNames.has(field)) {
      rejected.push(field);
      continue;
    }
    accepted[field] = value === null ? null : value;
  }
  return { accepted, rejected };
}

/** The org + RLS `where` every read starts from. `jobs` scopes on its own id;
 *  job-scoped tables on jobId; org-global tables aren't job-filtered at all. */
async function scopeWhere(
  ctx: OrgCtx,
  table: string,
  jobScoped: boolean,
  input: Record<string, unknown>,
  viewer?: ScopedViewer,
): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = { orgId: ctx.orgId };
  // The tool schema accepts a number or a string id (Airtable "rec…" ids
  // predate the migration); a numeric string must still filter, or the read
  // silently widens to every job in scope.
  const asked = input.jobId;
  const jobId =
    typeof asked === "number"
      ? asked
      : typeof asked === "string" && asked.trim() !== "" && Number.isFinite(Number(asked))
        ? Number(asked)
        : undefined;
  if (jobId !== undefined && jobScoped) where.jobId = jobId;

  // RLS: constrain to the viewer's assigned jobs. No-op for whole-tenant viewers.
  const pgScope = viewer ? await resolveJobScope(ctx, viewer) : await currentJobScope(ctx);
  if (pgScope.mode !== "all") {
    const ids =
      pgScope.mode === "some"
        ? [...pgScope.jobIds].map(Number).filter((n) => Number.isFinite(n))
        : [-1];
    if (table === "jobs") where.id = { in: ids };
    else if (jobScoped) where.jobId = { in: jobId !== undefined ? ids.filter((i) => i === jobId) : ids };
  }
  return where;
}

async function runQuery(
  ctx: OrgCtx,
  input: Record<string, unknown>,
  viewer?: ScopedViewer,
): Promise<string> {
  const table = String(input.table ?? "");
  const t = resolveTable(table);
  if (!t) {
    return `Unknown table "${table}". Readable tables: ${TABLE_KEYS.join(", ")}. Call describe_data for what each one holds.`;
  }
  const where = await scopeWhere(ctx, table, t.def.jobScoped, input, viewer);

  // `status` stays a first-class shortcut (it was the original filter and is
  // by far the most common one); everything else goes through `filters`.
  if (typeof input.status === "string" && input.status && t.fieldNames.has("status")) {
    where.status = input.status;
  }

  const { accepted, rejected } = buildFilters(table, input.filters);
  Object.assign(where, accepted);

  // Free-text search across the table's text columns — the `search_records`
  // equivalent. Without it, anything the user refers to by wording rather than
  // by id is unfindable.
  const search = typeof input.search === "string" ? input.search.trim() : "";
  if (search && t.searchable.length) {
    where.OR = t.searchable.map((f) => ({ [f]: { contains: search, mode: "insensitive" } }));
  }

  const limit = Math.min(Math.max(Number(input.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const offset = Math.max(Number(input.offset) || 0, 0);

  const sortField =
    typeof input.sortBy === "string" && t.fieldNames.has(input.sortBy) ? input.sortBy : "id";
  const sortDir = input.sortDirection === "asc" ? "asc" : "desc";

  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const model = (db(ctx) as any)[t.def.model];
  const [total, rows] = await Promise.all([
    model.count({ where }),
    model.findMany({ where, take: limit, skip: offset, orderBy: { [sortField]: sortDir } }),
  ]);

  const returned = rows.length;
  const truncated = offset + returned < total;
  return serialize({
    table,
    total,
    returned,
    offset,
    // Stated explicitly on every read: a model that can't tell a capped page
    // from the whole table will answer "how many…" from the page.
    truncated,
    ...(truncated
      ? {
          note: `Showing ${returned} of ${total} matching rows. Re-query with offset=${offset + returned} for the next page, or raise limit (max ${MAX_LIMIT}). Do not state totals or run calculations from this page alone — ${total} is the true match count.`,
        }
      : {}),
    ...(rejected.length ? { ignoredFilters: rejected } : {}),
    rows,
  });
}

/** Schema discovery — the `list_tables` / `describe_table` equivalent. With no
 *  table argument it lists the surface; with one it returns that table's
 *  columns and its row count in the viewer's scope. */
async function runDescribe(
  ctx: OrgCtx,
  input: Record<string, unknown>,
  currentUserRole?: string,
  viewer?: ScopedViewer,
): Promise<string> {
  const table = typeof input.table === "string" ? input.table.trim() : "";
  if (!table) {
    const tables = tableCatalog().filter(
      (t) => !currentUserRole || roleCanQueryTable(currentUserRole, t.table),
    );
    return serialize({ tables });
  }
  const t = resolveTable(table);
  if (!t) return `Unknown table "${table}". Readable tables: ${TABLE_KEYS.join(", ")}.`;
  if (currentUserRole && !roleCanQueryTable(currentUserRole, table)) {
    return `Role "${currentUserRole}" does not have access to the "${table}" table.`;
  }
  const where = await scopeWhere(ctx, table, t.def.jobScoped, {}, viewer);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const rowCount = await (db(ctx) as any)[t.def.model].count({ where });
  // The proposal surface, straight off the zod schemas: exactly which fields a
  // propose_create/propose_update may set. Without this the model has to guess
  // field names and gets rejected, which reads to the user as "it can't do it".
  const writer = WRITER_TABLE[table as keyof typeof WRITER_TABLE];
  const proposable =
    writer && (!currentUserRole || roleCanProposeOn(currentUserRole, writer, "update"))
      ? {
          create: writableFields(writer, "create"),
          requiredOnCreate: requiredCreateFields(writer),
          update: writableFields(writer, "update"),
        }
      : undefined;
  return serialize({
    table,
    description: t.def.description,
    jobScoped: t.def.jobScoped,
    rowCount,
    fields: tableFields(table),
    ...(proposable ? { proposable } : { proposable: false }),
  });
}

/** One row, every field, nothing clipped — the follow-up after a search or a
 *  clipped list read. */
async function runGetRecord(
  ctx: OrgCtx,
  input: Record<string, unknown>,
  viewer?: ScopedViewer,
): Promise<string> {
  const table = String(input.table ?? "");
  const t = resolveTable(table);
  if (!t) return `Unknown table "${table}". Readable tables: ${TABLE_KEYS.join(", ")}.`;
  const id = Number(input.recordId);
  if (!Number.isFinite(id)) return `get_record needs a numeric recordId (got "${String(input.recordId)}").`;
  // `AND` rather than `where.id = id`: on `jobs` the RLS scope already put an
  // `id: { in: … }` there, and overwriting it would step around the scope.
  const where = await scopeWhere(ctx, table, t.def.jobScoped, {}, viewer);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const row = await (db(ctx) as any)[t.def.model].findFirst({ where: { ...where, AND: [{ id }] } });
  if (!row) return `No ${table} record ${id} is visible to you.`;
  // No clipping here — this tool exists precisely to get the untruncated value.
  return JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
}

/** Per-tool input massaging: stamp provenance flags, allocate rule codes. */
async function toWriteData(
  ctx: OrgCtx,
  toolName: string,
  input: Record<string, unknown>,
  actor: Actor,
): Promise<Record<string, unknown>> {
  const data = { ...input };
  delete data.recordId;
  // Reviewer-facing metadata (Spec 12 Module 7 confirmation-card rationale) —
  // threaded through WriteRequest.rationale, never part of the record payload.
  delete data.proposalReason;
  switch (toolName) {
    case "create_action":
      data.sourceType = "chat";
      data.sourceId = actor.sourceMessageId;
      break;
    case "capture_source_note":
      data.title = data.title || String(data.note ?? "").trim().split(/\r?\n/)[0]?.slice(0, 120) || "Conversation note";
      data.kind = "generated";
      data.docType = "correspondence";
      data.classification = "correspondence";
      data.storageProvider = "conversation";
      data.storageRef = `chat:${actor.sourceMessageId ?? "session"}`;
      data.textContent = String(data.note ?? "");
      data.aiSummary = "Captured from conversation.";
      data.aiAnalysis = JSON.stringify({
        module2: {
          sourceChannel: "conversation",
          sourceRef: `chat:${actor.sourceMessageId ?? "session"}`,
        },
      });
      data.status = "captured";
      data.uploadedBy = actor.name;
      delete data.note;
      break;
    case "save_decision":
      data.sourceType = "chat";
      data.sourceId = actor.sourceMessageId;
      data.madeBy = data.madeBy || actor.name;
      break;
    case "create_risk":
      data.createdByAi = true;
      break;
    case "create_variation_draft":
      data.isAiDrafted = true;
      data.status = "draft";
      data.submittedBy = actor.name;
      break;
    case "propose_rule":
      data.kind = "guidance";
      // Allocated at write time by recordWriter (deferred approval would
      // invalidate a code allocated now).
      data.ruleCode = "AUTO";
      data.notes = "Proposed by the assistant in chat.";
      break;
  }
  return data;
}

/** Dispatch a "service" tool to the platform service that backs it. These
 *  produce human-reviewable drafts/suggestions (report draft, assessment draft,
 *  route hints) — the downstream approve/materialise step is the human gate, so
 *  they don't route through the recordWriter proposal queue. */
async function runServiceTool(
  ctx: OrgCtx,
  actor: Actor,
  name: string,
  input: Record<string, unknown>,
  viewer?: ScopedViewer,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case "generate_weekly_report": {
        const jobId = input.jobId as RecordId | undefined;
        const weekEnding = String(input.weekEnding ?? "").trim();
        if (jobId == null || !weekEnding) {
          return { toolName: name, ok: false, summary: "generate_weekly_report needs jobId and weekEnding (YYYY-MM-DD)." };
        }
        const { generateWeeklyReport } = await import("@/services/platform/construction/reports");
        const r = await generateWeeklyReport(ctx, actor.name, jobId, weekEnding);
        return {
          toolName: name,
          ok: true,
          status: "executed",
          recordId: r.id,
          summary: `Weekly report drafted (id ${r.id}) for week ending ${weekEnding}. It is a draft — a human must approve it before it is sent.`,
        };
      }
      case "run_construction_intake": {
        const intake = {
          name: String(input.name ?? "").trim(),
          engagementType: String(input.engagementType ?? "long_project"),
          address: String(input.address ?? ""),
          suburb: String(input.suburb ?? ""),
          scope: String(input.scope ?? ""),
          sizeSqm: input.sizeSqm != null ? Number(input.sizeSqm) : undefined,
          category: input.category != null ? String(input.category) : undefined,
        };
        if (!intake.name || !intake.scope) {
          return { toolName: name, ok: false, summary: "run_construction_intake needs at least a name and scope." };
        }
        const { runModule3Capability } = await import("@/services/platform/module3/engine");
        const res = await runModule3Capability(ctx, actor.name, { capability: "construction_intake", input: intake });
        return {
          toolName: name,
          ok: true,
          status: "executed",
          recordId: res.resultId,
          summary: `Construction intake assessment drafted (id ${res.resultId}, confidence ${res.overallConfidence}). It is a draft for human review — no job is created until it is accepted.`,
        };
      }
      case "suggest_ingestion_routes": {
        const { inferRouteSuggestions } = await import("@/lib/platform/ingestion");
        const text = String(input.text ?? "");
        const classification = String(input.classification ?? "other");
        const title = String(input.title ?? "").trim() || text.split(/\r?\n/)[0]?.slice(0, 120) || "Ingested source";
        const suggestions = inferRouteSuggestions({
          classification,
          text,
          title,
          docDate: new Date().toISOString().slice(0, 10),
          jobId: input.jobId as number | string | undefined,
        });
        return {
          toolName: name,
          ok: true,
          status: "executed",
          summary: suggestions.length
            ? `Routing suggestions (nothing written): ${JSON.stringify(suggestions)}`
            : "No routing suggestions inferred from this source.",
        };
      }
      case "onboarding_status": {
        // Provisioning new orgs stays in the /app/new form (cross-org, creates
        // external Airtable resources). The chat onboarding tool is read-only
        // and platform-admin gated: it reports the current org's readiness.
        // An explicit viewer (MCP path) carries the flag; only the viewerless
        // in-app path may consult the Clerk request context.
        const admin = viewer
          ? viewer.platformAdmin === true
          : await (await import("@/lib/platform/org-context")).isPlatformAdmin();
        if (!admin) {
          return { toolName: name, ok: false, summary: "Onboarding tools require a platform administrator." };
        }
        const cfg = ctx.config;
        const on = Object.entries(cfg.features).filter(([, v]) => v).map(([k]) => k);
        const off = Object.entries(cfg.features).filter(([, v]) => !v).map(([k]) => k);
        const status = {
          org: ctx.orgName,
          vertical: ctx.vertical,
          engagementTypes: ctx.allowedEngagementTypes,
          aiAuthority: ctx.aiAuthority,
          assistant: cfg.assistant.name,
          personaConfigured: cfg.assistant.persona.trim().length > 40,
          brandingLogo: !!cfg.branding?.logo,
          module1Governance: !!cfg.module1,
          featuresEnabled: on,
          featuresDisabled: off,
        };
        return { toolName: name, ok: true, status: "executed", summary: `Onboarding/config readiness: ${JSON.stringify(status)}` };
      }
      default:
        return { toolName: name, ok: false, summary: `Unknown service tool "${name}".` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { toolName: name, ok: false, summary: `Service tool failed: ${message.slice(0, 400)}` };
  }
}

/** Tables whose changes are always high-risk regardless of the op: money, and
 *  the rules that steer the assistant itself. Matches the risk the
 *  fixed-purpose tools already carried (update_budget_line, propose_rule). */
const HIGH_RISK_TABLES = new Set([
  "budget_line",
  "cashflow",
  "procurement",
  "quote",
  "quote_line",
  "learning_rule",
]);

/** The generic proposal path (mcp-assistant-plan: the assistant proposes, a
 *  human disposes). Table, op and fields all arrive as arguments, so every
 *  gate the fixed-purpose tools got from their static policy is applied here
 *  at execution time instead: the per-table role matrix, the read gate, the
 *  risk class, and finally the same recordWriter + aiAuthority approval path.
 *  Nothing here can write a record that the approval queue would not. */
async function runProposal(
  ctx: OrgCtx,
  actor: Actor,
  toolName: string,
  policy: ToolPolicy,
  input: Record<string, unknown>,
  currentUserRole?: string,
): Promise<ToolOutcome> {
  const key = String(input.table ?? "");
  const table = WRITER_TABLE[key as keyof typeof WRITER_TABLE];
  if (!table) {
    return {
      toolName,
      ok: false,
      summary: `"${key}" cannot be changed. Proposable tables: ${PROPOSABLE_KEYS.join(", ")}.`,
    };
  }
  const op = (policy.op ?? "update") as "create" | "update" | "delete";

  if (currentUserRole) {
    if (!roleCanQueryTable(currentUserRole, key)) {
      return { toolName, ok: false, summary: `Role "${currentUserRole}" has no access to "${key}".` };
    }
    if (!roleCanProposeOn(currentUserRole, table, op)) {
      return {
        toolName,
        ok: false,
        summary: `Role "${currentUserRole}" may not propose a ${op} on "${key}". Answer without doing it and say who can.`,
      };
    }
  }

  const risk = HIGH_RISK_TABLES.has(table) ? "high_write" : policy.risk;
  const rationale = typeof input.proposalReason === "string" ? input.proposalReason : undefined;

  // Reject unknown field names up front with the real list — a zod failure
  // deep in recordWriter tells the model far less than this does.
  let data: Record<string, unknown> = {};
  if (op !== "delete") {
    const raw = input.fields;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { toolName, ok: false, summary: `${toolName} needs a "fields" object.` };
    }
    const settable = new Set(writableFields(table, op === "create" ? "create" : "update"));
    const unknown = Object.keys(raw as Record<string, unknown>).filter((f) => !settable.has(f));
    if (unknown.length) {
      return {
        toolName,
        ok: false,
        summary: `Unknown field(s) on "${key}": ${unknown.join(", ")}. Settable fields are: ${[...settable].join(", ")}. Call describe_data for types.`,
      };
    }
    data = raw as Record<string, unknown>;
    if (op === "create") {
      const missing = requiredCreateFields(table).filter((f) => data[f] === undefined);
      if (missing.length) {
        return { toolName, ok: false, summary: `"${key}" needs: ${missing.join(", ")}.` };
      }
    }
  }

  const recordId = op === "create" ? undefined : (input.recordId as RecordId | undefined);
  if (op !== "create" && recordId == null) {
    return { toolName, ok: false, summary: `${toolName} needs a recordId.` };
  }

  try {
    const result = await writeRecord(ctx, {
      table,
      op,
      recordId,
      data,
      actor,
      requireApproval: requiresApproval(ctx.aiAuthority, risk),
      rationale,
    });
    const summary =
      result.status === "proposed"
        ? `Proposal #${result.proposalId} recorded — a human must approve before the ${op} on ${key} is applied. Tell the user it is pending approval.`
        : `${op} on ${key} executed (record id ${result.recordId}).`;
    return { toolName, ok: true, summary, status: result.status, proposalId: result.proposalId, recordId: result.recordId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { toolName, ok: false, summary: `Proposal rejected: ${message.slice(0, 400)}` };
  }
}

export async function executeToolUse(
  ctx: OrgCtx,
  actor: Actor,
  tu: ToolUse,
  toolPolicy: Record<string, ToolPolicy>,
  currentUserRole?: string,
  viewer?: ScopedViewer,
): Promise<ToolOutcome> {
  const policy = toolPolicy[tu.name];
  if (!policy) {
    return { toolName: tu.name, ok: false, summary: `Unknown tool "${tu.name}".` };
  }
  if (currentUserRole && !roleCanUseTool(currentUserRole, tu.name, toolPolicy)) {
    // Name the tool rather than declaring the role read-only: a builder or
    // architect CAN propose plenty, just not this, and "you are read-only" sent
    // the model off to tell the user it could do nothing at all.
    return {
      toolName: tu.name,
      ok: false,
      summary:
        tu.name === "propose_delete"
          ? `Role "${currentUserRole}" may not propose a delete — deletion is owner-only. Suggest a status change instead, or tell the user an owner must do it.`
          : `Role "${currentUserRole}" may not use "${tu.name}". Answer the request without it and say which role can, rather than implying the data cannot be changed at all.`,
    };
  }
  const input = (tu.input ?? {}) as Record<string, unknown>;

  // Service tools call a platform service (report/assessment/ingestion) rather
  // than recordWriter. Checked before the read branch because a service tool
  // may be read-risk (e.g. route suggestions) yet must not hit runQuery.
  if (policy.kind === "service") {
    return runServiceTool(ctx, actor, tu.name, input, viewer);
  }
  // Generic proposals resolve their table (and therefore their role gate and
  // risk class) from the arguments, so they run before the static-table path.
  if (policy.kind === "propose") {
    return runProposal(ctx, actor, tu.name, policy, input, currentUserRole);
  }

  if (policy.risk === "read") {
    // Spec 12 role-scoped context: financial and restricted tables are not
    // readable below the Owner role, even via the generic read tools.
    // describe_data self-filters (it lists only permitted tables), so it is
    // gated inside its own handler rather than here.
    if (
      (tu.name === "query_records" || tu.name === "get_record") &&
      currentUserRole &&
      !roleCanQueryTable(currentUserRole, String(input.table ?? ""))
    ) {
      return {
        toolName: tu.name,
        ok: false,
        summary: `Role "${currentUserRole}" does not have access to the "${String(input.table ?? "")}" table. Answer without that data and say the detail is restricted to the owner role.`,
      };
    }
    try {
      const summary =
        tu.name === "describe_data"
          ? await runDescribe(ctx, input, currentUserRole, viewer)
          : tu.name === "get_record"
            ? await runGetRecord(ctx, input, viewer)
            : await runQuery(ctx, input, viewer);
      return { toolName: tu.name, ok: true, summary };
    } catch (err) {
      return { toolName: tu.name, ok: false, summary: `Query failed: ${err}` };
    }
  }

  const table = policy.table as WritableTable;
  const op = policy.op ?? "create";
  try {
    if (tu.name === "capture_source_note") {
      const { captureConversationNote } = await import("@/services/platform/documents");
      const recordId = await captureConversationNote(ctx, actor.name, {
        jobId: input.jobId as RecordId | undefined,
        title: typeof input.title === "string" ? input.title : undefined,
        note: String(input.note ?? ""),
        sessionId: actor.sourceMessageId,
      });
      return {
        toolName: tu.name,
        ok: true,
        summary: `Source note captured as document ${recordId}.`,
        status: "executed",
        recordId,
      };
    }
    const data = await toWriteData(ctx, tu.name, input, actor);
    const result = await writeRecord(ctx, {
      table,
      op,
      // Keep the id as-is: Airtable "rec…" ids must not be coerced to NaN;
      // recordWriter narrows numeric strings to the Postgres Int itself.
      recordId: op === "update" ? (input.recordId as RecordId | undefined) : undefined,
      data,
      actor,
      requireApproval: requiresApproval(ctx.aiAuthority, policy.risk),
      rationale: typeof input.proposalReason === "string" ? input.proposalReason : undefined,
    });
    const summary =
      result.status === "proposed"
        ? `Proposal #${result.proposalId} recorded — a human must approve before the ${op} on ${table} is applied. Tell the user it is pending approval.`
        : `${op} on ${table} executed (record id ${result.recordId}).`;
    return { toolName: tu.name, ok: true, summary, status: result.status, proposalId: result.proposalId, recordId: result.recordId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { toolName: tu.name, ok: false, summary: `Write rejected: ${message.slice(0, 400)}` };
  }
}
