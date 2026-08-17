// Assistant tool definitions — the "save this" mechanism from the Platform
// Architecture doc. Each write tool maps to a fixed recordWriter table (the
// model never names tables) with a risk class that the org's aiAuthority
// policy uses to decide execute-now vs propose-for-approval.
//
// Transport-neutral (MCP plan W1a): definitions are ToolContract, not SDK
// types — lib/claude.ts adapts to Anthropic; the planned MCP server reads
// the same registry.

import type { ToolContract } from "@/lib/platform/toolContract";
import type { WritableTable } from "@/lib/platform/recordWriter";
import { normalizeTeamRole } from "@/lib/platform/module1Governance";
import { financeVisible } from "@/lib/platform/roles";
import { PROPOSABLE_KEYS, TABLE_KEYS } from "./dataCatalog";

export interface ToolPolicy {
  table?: WritableTable;
  op?: "create" | "update" | "delete";
  risk: "read" | "low_write" | "high_write";
  /** "record" (default) → routed through recordWriter under the aiAuthority
   *  gate, against the table fixed in this policy. "service" → dispatched to a
   *  platform service that produces a human-reviewable draft/suggestion
   *  (report, assessment, route hints); the downstream lifecycle step
   *  (approve/materialise) is the human gate. "propose" → same recordWriter
   *  path, but the table and fields come from the tool call, so the table gate
   *  (roleCanProposeOn) and risk class are resolved at execution time. */
  kind?: "record" | "service" | "propose";
}

// Spec 12 role-scoped write access (Module 7): Owner confirms anything;
// Builder writes to PLAN and ISSUES only (no budget, no risks, no decisions);
// Architect additionally drafts scope changes (variation orders = CHANGE_LOG)
// but has no financial write; Broker is read-only except creating ISSUES
// (Decision Required flagging). All writes remain approval-gated downstream.
const ROLE_WRITE_ALLOW: Record<string, ReadonlySet<string>> = {
  builder: new Set([
    "create_action",
    "update_action",
    "log_workstream_update",
    "capture_source_note",
    "generate_weekly_report",
    // The generic proposal tools pass the tool-name gate for every role that
    // may propose anything; WHICH table they may touch is decided by
    // roleCanProposeOn below, since the table is a runtime argument.
    "propose_create",
    "propose_update",
  ]),
  architect: new Set([
    "create_action",
    "update_action",
    "log_workstream_update",
    "capture_source_note",
    "create_variation_draft",
    "generate_weekly_report",
    "propose_create",
    "propose_update",
  ]),
  broker: new Set(["create_action", "propose_create"]),
};

// ── Which tables each role may propose changes to ────────────────────────────
// The per-table half of the write gate. Owner is unrestricted; every other role
// gets the same scope Spec 12 gave it through the old fixed-purpose tools, now
// expressed once against recordWriter's table keys instead of being implied by
// a tool name. Deletion is owner-only, always — see roleCanProposeOn.
const BUILDER_TABLES = [
  "action",
  "plan",
  "workstream",
  "document",
  "phase_evidence",
  "meeting_minutes",
  "weekly_report",
] as const;
const ARCHITECT_TABLES = [
  ...BUILDER_TABLES,
  "variation_order",
  "phase",
  "room",
  "bim_model",
] as const;

const ROLE_TABLE_ALLOW: Record<string, ReadonlySet<string>> = {
  builder: new Set<string>(BUILDER_TABLES),
  architect: new Set<string>(ARCHITECT_TABLES),
  broker: new Set<string>(["action"]),
};

/** recordWriter tables that carry money — unlocked for a Finance Manager /
 *  Auditor sub-role the same way the financial READ tables are. */
const FINANCIAL_WRITE = new Set(["budget_line", "cashflow", "procurement", "quote", "quote_line"]);

/** May `role` propose `op` on recordWriter table `table`? */
export function roleCanProposeOn(
  role: string,
  table: string,
  op: "create" | "update" | "delete",
): boolean {
  const normalized = normalizeTeamRole(role);
  if (normalized === "owner") return true;
  // Deleting client records is owner-only regardless of table. A proposal is
  // only a proposal, but a non-owner should not be able to put "delete the
  // budget" in front of a reviewer as a one-click approval.
  if (op === "delete") return false;
  if (FINANCIAL_WRITE.has(table) && financeVisible(role)) return true;
  const allowed = ROLE_TABLE_ALLOW[normalized]?.has(table) ?? false;
  if (!allowed) return false;
  // Broker is create-only (raising an issue), matching its read-only posture.
  if (normalized === "broker" && op !== "create") return false;
  return true;
}

export function roleCanUseTool(
  role: string,
  toolName: string,
  policyMap: Record<string, ToolPolicy> = TOOL_POLICY,
): boolean {
  const normalized = normalizeTeamRole(role);
  const policy = policyMap[toolName];
  if (!policy) return false;
  if (policy.risk === "read") return true;
  if (normalized === "owner") return true;
  return ROLE_WRITE_ALLOW[normalized]?.has(toolName) ?? false;
}

// Spec 12 role-scoped read access: financial tables (BUDGET/CASHFLOWS/QUOTES)
// are Owner-only; RISKS is hidden from Builder/Architect; the learning stores
// (LEARNING_RULES/HYPOTHESES/CORRECTIONS) and org SETTINGS from all non-owner
// roles; PROCUREMENT is financial detail the Architect doesn't get.
//
// Widening the readable surface to full Airtable parity means every newly
// reachable table has to land in this matrix deliberately — a table that is
// merely absent here is readable by everyone.
const FINANCIAL = ["budget_lines", "cashflows", "procurement", "quotes", "quote_lines"] as const;
const LEARNING = [
  "learning_rules",
  "hypotheses",
  "corrections",
  "intelligence_snapshot",
  "settings",
] as const;

const ROLE_QUERY_DENY: Record<string, ReadonlySet<string>> = {
  builder: new Set<string>([
    "budget_lines",
    "cashflows",
    "quotes",
    "quote_lines",
    "risks",
    ...LEARNING,
  ]),
  architect: new Set<string>([...FINANCIAL, "risks", ...LEARNING]),
  broker: new Set<string>(["budget_lines", "cashflows", "quotes", "quote_lines", ...LEARNING]),
};

export function roleCanQueryTable(role: string, table: string): boolean {
  const normalized = normalizeTeamRole(role);
  if (normalized === "owner") return true;
  const denied = ROLE_QUERY_DENY[normalized]?.has(table) ?? false;
  if (!denied) return true;
  // CLS (governance §3): Finance Manager / Auditor sub-roles unlock the
  // financial tables their base role would otherwise be denied.
  if ((FINANCIAL as readonly string[]).includes(table)) return financeVisible(role);
  return false;
}

export const TOOL_POLICY: Record<string, ToolPolicy> = {
  query_records: { risk: "read" },
  describe_data: { risk: "read" },
  get_record: { risk: "read" },
  // Generic proposal surface — any proposable table, any settable field. Risk
  // is escalated per table at execution time (financial/learning → high_write).
  propose_create: { risk: "low_write", kind: "propose", op: "create" },
  propose_update: { risk: "low_write", kind: "propose", op: "update" },
  // Deletion is always high-risk: gated even under auto_low_risk.
  propose_delete: { risk: "high_write", kind: "propose", op: "delete" },
  capture_source_note: { table: "document", op: "create", risk: "low_write" },
  create_action: { table: "action", op: "create", risk: "low_write" },
  update_action: { table: "action", op: "update", risk: "low_write" },
  save_decision: { table: "decision", op: "create", risk: "low_write" },
  propose_rule: { table: "learning_rule", op: "create", risk: "high_write" },
  update_budget_line: { table: "budget_line", op: "update", risk: "high_write" },
  create_variation_draft: { table: "variation_order", op: "create", risk: "high_write" },
  create_risk: { table: "risk", op: "create", risk: "low_write" },
  // Outward-facing communication (Spec 12 send_email via the COMMS lifecycle,
  // lock plan §7.2): high_write so it is ALWAYS approval-gated, even under
  // auto_low_risk. On approval, recordWriter emits the comms.create outbound
  // event; the n8n integration layer owns delivery and marks the record Sent.
  draft_comm: { table: "comms", op: "create", risk: "high_write" },
  log_workstream_update: { table: "workstream", op: "update", risk: "low_write" },
  generate_weekly_report: { risk: "low_write", kind: "service" },
  run_construction_intake: { risk: "low_write", kind: "service" },
  suggest_ingestion_routes: { risk: "read", kind: "service" },
  onboarding_status: { risk: "read", kind: "service" },
};

const jobIdProp = {
  jobId: {
    oneOf: [{ type: "number" as const }, { type: "string" as const }],
    description: 'Job id the record belongs to (numeric in Postgres, "rec..." in Airtable).',
  },
};

const recordIdProp = {
  oneOf: [{ type: "number" as const }, { type: "string" as const }],
};

// Spec 12 Module 7: the confirmation card shows the proposer's rationale.
// Meta-only — the executor lifts it off the payload before the write; it is
// never stored on the record. (Named proposalReason, not "rationale", because
// save_decision has a real `rationale` record field.)
const proposalReasonProp = {
  proposalReason: {
    type: "string" as const,
    description:
      "One sentence explaining WHY this change is proposed — shown to the human on the approval card. Always provide it.",
  },
};

export const ASSISTANT_TOOLS: ToolContract[] = [
  {
    name: "describe_data",
    description:
      "Discover what data exists. With no arguments, lists every readable table and what it holds. With a table name, returns that table's exact field names and types plus its row count in your scope. Call this when you are unsure which table or field holds something, rather than guessing a name or telling the user the data is unavailable.",
    input_schema: {
      type: "object",
      properties: {
        table: {
          type: "string",
          enum: [...TABLE_KEYS],
          description: "Omit to list all tables; supply one to describe its fields.",
        },
      },
    },
  },
  {
    name: "query_records",
    description:
      "Read project data. Returns full rows as JSON along with `total` (how many rows actually match) and `truncated`. Supports free-text search, field filters, sorting and paging. Use it before proposing changes so values are grounded in the database. If `truncated` is true you are looking at one page — page through with `offset` before stating any total, count or sum.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", enum: [...TABLE_KEYS] },
        search: {
          type: "string",
          description:
            "Free-text match across the table's text fields (case-insensitive). Use this whenever the user refers to something by wording rather than by id.",
        },
        jobId: { ...jobIdProp.jobId, description: "Optional job id filter." },
        status: { type: "string", description: "Optional status filter." },
        filters: {
          type: "object",
          description:
            'Exact-match filters keyed by field name, e.g. {"priority":"P1","owner":"Jack"}. Field names must come from describe_data; unknown ones are ignored and reported back.',
        },
        sortBy: { type: "string", description: "Field to sort by (default: id)." },
        sortDirection: { type: "string", enum: ["asc", "desc"], description: "Default desc." },
        limit: { type: "number", description: "Rows per page (default 50, max 200)." },
        offset: { type: "number", description: "Rows to skip — use with `total` to page." },
      },
      required: ["table"],
    },
  },
  {
    name: "get_record",
    description:
      "Fetch one record by id with every field untruncated. Use after query_records when a long field (document text, meeting minutes, notes) was clipped, or to confirm a record before proposing a change to it.",
    input_schema: {
      type: "object",
      properties: {
        table: { type: "string", enum: [...TABLE_KEYS] },
        recordId: { type: "number", description: "The record's numeric id." },
      },
      required: ["table", "recordId"],
    },
  },
  {
    name: "propose_create",
    description:
      "Propose creating a record in any table, setting any of its fields. Call describe_data first to get the exact field names for the table. This creates a proposal for human approval, not the record itself — say so when you report back. Prefer this over the fixed-purpose create tools when you need fields they do not expose.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        table: { type: "string", enum: [...PROPOSABLE_KEYS] },
        fields: {
          type: "object",
          description:
            'The record\'s field values, e.g. {"jobId": 3, "title": "Order render", "priority": "P1"}. Field names must match describe_data exactly; unknown names are rejected with the list of valid ones.',
        },
      },
      required: ["table", "fields"],
    },
  },
  {
    name: "propose_update",
    description:
      "Propose changing any fields of an existing record in any table. Only the fields you supply change. Read the record first (get_record) so the proposal is grounded in its current values. Creates a proposal for human approval, not the change itself.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        table: { type: "string", enum: [...PROPOSABLE_KEYS] },
        recordId: { type: "number", description: "The record's numeric id." },
        fields: { type: "object", description: "Field values to change." },
      },
      required: ["table", "recordId", "fields"],
    },
  },
  {
    name: "propose_delete",
    description:
      "Propose deleting a record. ALWAYS requires human approval and is owner-only. Use sparingly — prefer proposing a status change (e.g. cancelled, superseded) over deletion, and say which you chose and why.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        table: { type: "string", enum: [...PROPOSABLE_KEYS] },
        recordId: { type: "number", description: "The record's numeric id." },
      },
      required: ["table", "recordId", "proposalReason"],
    },
  },
  {
    name: "capture_source_note",
    description:
      "Capture important source material from the conversation as a persistent document/note so it can be traced later.",
    input_schema: {
      type: "object",
      properties: {
        ...jobIdProp,
        title: { type: "string" },
        note: { type: "string", description: "The substantive note or source content to preserve." },
      },
      required: ["note"],
    },
  },
  {
    name: "create_action",
    description: "Create an action item in the Action Hub.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        ...jobIdProp,
        title: { type: "string" },
        detail: { type: "string" },
        priority: { type: "string", enum: ["P1", "P2", "P3"] },
        owner: { type: "string" },
        dueDate: { type: "string", description: "YYYY-MM-DD" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_action",
    description: "Update an existing action item (status, owner, due date…).",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        recordId: { ...recordIdProp, description: "Action id." },
        status: { type: "string", enum: ["open", "in_progress", "done", "deferred"] },
        owner: { type: "string" },
        dueDate: { type: "string", description: "YYYY-MM-DD" },
        detail: { type: "string" },
      },
      required: ["recordId"],
    },
  },
  {
    name: "save_decision",
    description:
      "Record a project decision discussed in this conversation so it persists beyond the session.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        ...jobIdProp,
        description: { type: "string" },
        rationale: { type: "string" },
        category: { type: "string" },
        status: { type: "string", enum: ["proposed", "confirmed"] },
      },
      required: ["description"],
    },
  },
  {
    name: "propose_rule",
    description:
      "Propose a new learning rule (guidance the assistant must follow in future sessions). Always requires human approval.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        description: { type: "string" },
        category: { type: "string" },
      },
      required: ["description"],
    },
  },
  {
    name: "update_budget_line",
    description: "Update a budget line's amounts (budget, committed or actual).",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        recordId: { ...recordIdProp, description: "Budget line id (from query_records)." },
        budgetAmount: { type: "number" },
        committedAmount: { type: "number" },
        actualAmount: { type: "number" },
      },
      required: ["recordId"],
    },
  },
  {
    name: "create_variation_draft",
    description: "Draft a variation order for human review.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        ...jobIdProp,
        title: { type: "string" },
        description: { type: "string" },
        scopeChange: { type: "string" },
        costImpact: { type: "number" },
        timeImpactDays: { type: "number" },
      },
      required: ["jobId", "title"],
    },
  },
  {
    name: "create_risk",
    description: "Add a risk to the register.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        ...jobIdProp,
        description: { type: "string" },
        likelihood: { type: "number", description: "1–5" },
        impact: { type: "number", description: "1–5" },
        mitigation: { type: "string" },
        owner: { type: "string" },
      },
      required: ["jobId", "description"],
    },
  },
  {
    name: "draft_comm",
    description:
      "Draft a stakeholder communication (who needs to be told what, by when). Creates a Pending COMMS record that ALWAYS requires human approval; once approved, the outbound integration delivers it and marks it Sent. Use this instead of promising to send anything yourself.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        ...jobIdProp,
        topic: { type: "string", description: "What needs to be communicated." },
        messageType: {
          type: "string",
          enum: ["Decision Notification", "Status Update", "Action Required", "Approval Request", "Escalation"],
        },
        stakeholderRole: {
          type: "string",
          enum: ["Owner", "Builder", "Architect", "Broker", "Supplier", "Regulatory", "Other"],
        },
        dueDate: { type: "string", description: "YYYY-MM-DD — when this must be communicated by." },
        notes: { type: "string", description: "Message body / talking points for the sender." },
      },
      required: ["topic"],
    },
  },
  {
    name: "log_workstream_update",
    description: "Update a workstream's status/notes at session close.",
    input_schema: {
      type: "object",
      properties: {
        ...proposalReasonProp,
        recordId: { ...recordIdProp, description: "Workstream id." },
        status: { type: "string" },
        notes: { type: "string" },
        milestone: { type: "string" },
      },
      required: ["recordId"],
    },
  },
  {
    name: "generate_weekly_report",
    description:
      "Generate a draft weekly client report for a job from its live data (progress, budget, risks, next week). Creates a draft that a human approves before it is sent.",
    input_schema: {
      type: "object",
      properties: {
        jobId: { ...jobIdProp.jobId, description: "Job to report on." },
        weekEnding: { type: "string", description: "Week-ending date, YYYY-MM-DD." },
      },
      required: ["jobId", "weekEnding"],
    },
  },
  {
    name: "run_construction_intake",
    description:
      "Run a construction intake assessment (Assessment Engine): from scope, address and size it drafts a budget, phase plan and risks for human review before a job is created. Produces a draft assessment, not a job.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Prospective job name." },
        scope: { type: "string", description: "Scope of work." },
        address: { type: "string" },
        suburb: { type: "string" },
        engagementType: {
          type: "string",
          enum: ["short_job", "long_project", "ongoing", "seasonal"],
        },
        sizeSqm: { type: "number" },
        category: { type: "string", description: "Optional job-category catalog key." },
      },
      required: ["name", "scope"],
    },
  },
  {
    name: "suggest_ingestion_routes",
    description:
      "Given raw source text (e.g. an email or document body) and its classification, suggest how it should be routed into the system (cashflow, procurement, decision or action). Read-only — returns suggestions, writes nothing.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The source text to analyse." },
        classification: {
          type: "string",
          enum: ["invoice", "quote", "contract", "specification", "report", "correspondence", "other"],
        },
        jobId: { ...jobIdProp.jobId, description: "Optional job the source relates to." },
        title: { type: "string", description: "Optional source title." },
      },
      required: ["text", "classification"],
    },
  },
  {
    name: "onboarding_status",
    description:
      "Report the current organisation's Day-1 configuration readiness: enabled/disabled features, engagement types, AI write authority, assistant setup, branding and governance. Read-only; platform-admin only.",
    input_schema: {
      type: "object",
      properties: {},
    },
  },
];

// Per-agent tool bundles are built by name from the shared definitions above,
// so the tool schema + policy stay single-sourced (and the full-union exports
// ASSISTANT_TOOLS / TOOL_POLICY remain intact for the policy tests).

/** An agent's tool subset, selected by tool name. */
export function toolsByName(names: readonly string[]): ToolContract[] {
  return ASSISTANT_TOOLS.filter((t) => names.includes(t.name));
}

/** An agent's policy subset (only the named tools that have a policy). */
export function policyByName(names: readonly string[]): Record<string, ToolPolicy> {
  const out: Record<string, ToolPolicy> = {};
  for (const n of names) if (TOOL_POLICY[n]) out[n] = TOOL_POLICY[n];
  return out;
}
