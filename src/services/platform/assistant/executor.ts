// Executes assistant tool calls. Reads run directly (org-scoped); writes go
// through recordWriter under the org's aiAuthority policy — executed
// immediately or queued as a PlatPendingWrite proposal for human approval.
// This is the step UC2/UC3 never had: tagged chat outputs become real
// database rows.

import { db, prisma } from "@/lib/db";
import { airtableEnabled, core } from "@/lib/airtable";
import type { ToolUse } from "@/lib/claude";
import { writeRecord, WritableTable, type RecordId } from "@/lib/platform/recordWriter";
import { Actor, AiAuthority, OrgCtx } from "@/lib/platform/types";
import { currentJobScope, inScope } from "@/lib/platform/rls";
import { roleCanQueryTable, roleCanUseTool, type ToolPolicy } from "./tools";

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

const QUERYABLE = {
  jobs: (ctx: OrgCtx) =>
    ({ model: db(ctx).platJob, select: { id: true, code: true, name: true, engagementType: true, status: true, completionPct: true, budgetTotal: true } }),
  actions: (ctx: OrgCtx) =>
    ({ model: db(ctx).platActionHub, select: { id: true, jobId: true, title: true, priority: true, status: true, owner: true, dueDate: true } }),
  decisions: (ctx: OrgCtx) =>
    ({ model: db(ctx).platDecision, select: { id: true, jobId: true, description: true, status: true, madeBy: true, category: true } }),
  phases: (ctx: OrgCtx) =>
    ({ model: db(ctx).platConPhase, select: { id: true, jobId: true, name: true, status: true, completionPct: true, sortOrder: true, isAiDraft: true } }),
  budget_lines: (ctx: OrgCtx) =>
    ({ model: db(ctx).platConBudgetLine, select: { id: true, jobId: true, phaseId: true, category: true, description: true, budgetAmount: true, committedAmount: true, actualAmount: true } }),
  // Legacy shape — cashflow writes are Airtable-only (Spec 12 ledger); this
  // Postgres read only surfaces pre-migration/seeded rows.
  cashflows: (ctx: OrgCtx) =>
    ({ model: db(ctx).platConCashflow, select: { id: true, jobId: true, period: true, projected: true, actual: true } }),
  risks: (ctx: OrgCtx) =>
    ({ model: db(ctx).platConRisk, select: { id: true, jobId: true, description: true, likelihood: true, impact: true, status: true, owner: true } }),
  variations: (ctx: OrgCtx) =>
    ({ model: db(ctx).platConVariationOrder, select: { id: true, jobId: true, refNumber: true, title: true, costImpact: true, timeImpactDays: true, status: true } }),
  procurement: (ctx: OrgCtx) =>
    ({ model: db(ctx).platConProcurement, select: { id: true, jobId: true, item: true, vendorName: true, total: true, status: true, dueDate: true } }),
  vendors: (ctx: OrgCtx) =>
    ({ model: db(ctx).platConVendor, select: { id: true, name: true, category: true, rating: true, isActive: true } }),
  learning_rules: (ctx: OrgCtx) =>
    ({ model: db(ctx).platLearningRule, select: { id: true, ruleCode: true, kind: true, description: true, confidence: true, isActive: true } }),
  documents: (ctx: OrgCtx) =>
    ({ model: db(ctx).platDocument, select: { id: true, jobId: true, title: true, docType: true, status: true, uploadedBy: true, version: true } }),
} as const;

async function runQuery(ctx: OrgCtx, input: Record<string, unknown>): Promise<string> {
  const table = String(input.table ?? "");
  if (airtableEnabled(ctx)) {
    const map = {
      jobs: "JOBS",
      actions: "ISSUES",
      decisions: "DECISIONS",
      phases: "PHASES",
      budget_lines: "BUDGET",
      cashflows: "CASHFLOWS",
      risks: "RISKS",
      variations: "CHANGE_LOG", // Spec 12: variations are Change_Type="Variation" rows
      procurement: "PROCUREMENT",
      vendors: "VENDORS",
      learning_rules: "LEARNING_RULES",
      documents: "DOCUMENTS",
    } as const;
    const tableName = map[table as keyof typeof map];
    if (!tableName) return `Unknown table "${table}".`;
    const status = typeof input.status === "string" ? input.status.trim() : "";
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
    const jobId = typeof input.jobId === "string" || typeof input.jobId === "number" ? String(input.jobId) : "";
    const allRows = await core.list(ctx.orgSlug, tableName, { maxRecords: 500 });
    // CHANGE_LOG holds every change type; the variations view is only the
    // Change_Type="Variation" rows.
    const rows =
      table === "variations" ? allRows.filter((r) => r["Change_Type"] === "Variation") : allRows;
    const withJob = ["jobs", "vendors", "learning_rules"].includes(table)
      ? rows
      : rows.filter((r) => {
          const link = r["Job"];
          return !jobId || (Array.isArray(link) && link.map(String).includes(jobId));
        });
    // RLS: the assistant only reads rows on the viewer's assigned jobs (no-op
    // until TEAM assignments exist). "jobs" scopes on the record's own id;
    // vendors/learning_rules are org-global.
    const scope = await currentJobScope(ctx);
    const jobOf = (r: Record<string, unknown>): string | null => {
      if (table === "jobs") return typeof r.id === "string" ? r.id : null;
      if (table === "vendors" || table === "learning_rules") return null;
      const link = r["Job"];
      return Array.isArray(link) && link.length > 0 ? String(link[0]) : null;
    };
    const withScope = withJob.filter((r) => inScope(scope, jobOf(r)));
    const withStatus = !status
      ? withScope
      : withScope.filter((r) => String(r["Status"] ?? "").toLowerCase() === status.toLowerCase());
    return JSON.stringify(withStatus.slice(0, limit));
  }
  const def = QUERYABLE[table as keyof typeof QUERYABLE];
  if (!def) return `Unknown table "${table}".`;
  const { model, select } = def(ctx);
  const where: Record<string, unknown> = { orgId: ctx.orgId };
  const jobScoped = table !== "jobs" && table !== "vendors" && table !== "learning_rules";
  if (typeof input.jobId === "number" && jobScoped) where.jobId = input.jobId;
  // RLS: constrain to the viewer's assigned jobs (Postgres path; the Airtable
  // path above is already scoped). No-op for whole-tenant viewers.
  const pgScope = await currentJobScope(ctx);
  if (pgScope.mode !== "all") {
    const ids = pgScope.mode === "some" ? [...pgScope.jobIds].map(Number).filter((n) => Number.isFinite(n)) : [-1];
    if (table === "jobs") where.id = { in: ids };
    else if (jobScoped) where.jobId = { in: ids };
  }
  if (typeof input.status === "string" && input.status) where.status = input.status;
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 50);
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  const rows = await (model as any).findMany({ where, select, take: limit, orderBy: { id: "desc" } });
  return JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
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
        const { isPlatformAdmin } = await import("@/lib/platform/org-context");
        if (!(await isPlatformAdmin())) {
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

export async function executeToolUse(
  ctx: OrgCtx,
  actor: Actor,
  tu: ToolUse,
  toolPolicy: Record<string, ToolPolicy>,
  currentUserRole?: string,
): Promise<ToolOutcome> {
  const policy = toolPolicy[tu.name];
  if (!policy) {
    return { toolName: tu.name, ok: false, summary: `Unknown tool "${tu.name}".` };
  }
  if (currentUserRole && !roleCanUseTool(currentUserRole, tu.name, toolPolicy)) {
    return {
      toolName: tu.name,
      ok: false,
      summary: `Role "${currentUserRole}" is read-only for assistant writes. This request can be answered, but no records will be created or updated.`,
    };
  }
  const input = (tu.input ?? {}) as Record<string, unknown>;

  // Service tools call a platform service (report/assessment/ingestion) rather
  // than recordWriter. Checked before the read branch because a service tool
  // may be read-risk (e.g. route suggestions) yet must not hit runQuery.
  if (policy.kind === "service") {
    return runServiceTool(ctx, actor, tu.name, input);
  }

  if (policy.risk === "read") {
    // Spec 12 role-scoped context: financial and restricted tables are not
    // readable below the Owner role, even via the generic query tool.
    if (
      tu.name === "query_records" &&
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
      return { toolName: tu.name, ok: true, summary: await runQuery(ctx, input) };
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
