// The assistant's readable data surface — the parity layer with an Airtable
// MCP server.
//
// Claude talking to Airtable over MCP can list the base's tables, describe a
// table's fields, list records with every field populated, search across them
// and page through the lot. Anything narrower than that shows up to the user
// as the assistant "not knowing" things that are plainly in the data, so this
// catalog deliberately mirrors that surface over the tenant Postgres schema:
// every migrated table is reachable, every scalar column is returned, and a
// truncated read says so instead of looking complete.
//
// Field lists come from Prisma's DMMF rather than a hand-written `select`, so
// a schema change can't silently hide a column from the assistant the way the
// previous per-table select did.
//
// What this layer does NOT relax: tenancy. Every read still goes through
// db(ctx) (org-isolation guard), still carries orgId, still narrows to the
// viewer's RLS job scope, and still passes the per-table role denies. The
// surface widens; the walls don't move.

import { Prisma } from "@prisma/client";
import type { WritableTable } from "@/lib/platform/recordWriter";

export type TableKey = keyof typeof TABLES;

interface TableDef {
  /** Prisma delegate name on the tenant client. */
  model: string;
  /** Prisma model name in the DMMF (for field discovery). */
  dmmf: string;
  /** What the table holds — shown to the model by `describe_data`. */
  description: string;
  /** False for org-global tables (no jobId column): vendors, contacts, rules… */
  jobScoped: boolean;
}

/** The readable tables, keyed by the name the model uses in tool calls.
 *  Keys are stable API: the original twelve are unchanged. */
const TABLES = {
  // ── Engagement core ────────────────────────────────────────────────────────
  jobs: {
    model: "platJob",
    dmmf: "PlatJob",
    description: "Projects/engagements. The top-level record everything else hangs off.",
    jobScoped: false,
  },
  actions: {
    model: "platActionHub",
    dmmf: "PlatActionHub",
    description: "Action Hub items / issues — tasks, blockers and decisions-required.",
    jobScoped: true,
  },
  decisions: {
    model: "platDecision",
    dmmf: "PlatDecision",
    description: "Recorded project decisions with rationale and alternatives.",
    jobScoped: true,
  },
  phases: {
    model: "platConPhase",
    dmmf: "PlatConPhase",
    description: "Construction phases in sequence, with completion and RAG status.",
    jobScoped: true,
  },
  plan: {
    model: "platConPlanTask",
    dmmf: "PlatConPlanTask",
    description:
      "The programme/plan: individual scheduled tasks with dates, durations, predecessors and RAG.",
    jobScoped: true,
  },
  workstreams: {
    model: "platWorkstream",
    dmmf: "PlatWorkstream",
    description: "Workstreams and their milestones/status notes.",
    jobScoped: true,
  },

  // ── Money ──────────────────────────────────────────────────────────────────
  budget_lines: {
    model: "platConBudgetLine",
    dmmf: "PlatConBudgetLine",
    description: "Budget lines per category/phase: budget, committed and actual amounts.",
    jobScoped: true,
  },
  cashflows: {
    model: "platConCashflowLedger",
    dmmf: "PlatConCashflowLedger",
    description:
      "The cashflow ledger — one row per transaction (period, type, payee, amount, status).",
    jobScoped: true,
  },
  procurement: {
    model: "platConProcurement",
    dmmf: "PlatConProcurement",
    description: "Procurement items: what was ordered, from whom, for how much, and its status.",
    jobScoped: true,
  },
  variations: {
    model: "platConVariationOrder",
    dmmf: "PlatConVariationOrder",
    description: "Variation orders — scope changes with cost and time impact.",
    jobScoped: true,
  },
  change_log: {
    model: "platConChangeLog",
    dmmf: "PlatConChangeLog",
    description: "Change log entries raised against the engagement.",
    jobScoped: true,
  },
  quotes: {
    model: "platConQuote",
    dmmf: "PlatConQuote",
    description: "Client quotes.",
    jobScoped: true,
  },
  quote_lines: {
    model: "platConQuoteLine",
    dmmf: "PlatConQuoteLine",
    description: "Line items belonging to a quote.",
    jobScoped: false,
  },

  // ── Risk, people, places ───────────────────────────────────────────────────
  risks: {
    model: "platConRisk",
    dmmf: "PlatConRisk",
    description: "Risk register: likelihood, impact, mitigation and owner.",
    jobScoped: true,
  },
  contacts: {
    model: "platContact",
    dmmf: "PlatContact",
    description: "People and companies: name, role, email, phone, company.",
    jobScoped: false,
  },
  vendors: {
    model: "platConVendor",
    dmmf: "PlatConVendor",
    description: "Supplier/vendor directory with contact details and ratings.",
    jobScoped: false,
  },
  team: {
    model: "platCfgTeamMember",
    dmmf: "PlatCfgTeamMember",
    description: "Org team members and their platform roles.",
    jobScoped: false,
  },
  rooms: {
    model: "platConRoomMatrix",
    dmmf: "PlatConRoomMatrix",
    description: "Room matrix: zones, rooms, dimensions, ceiling heights and finishes.",
    jobScoped: true,
  },

  // ── Documents and comms ────────────────────────────────────────────────────
  documents: {
    model: "platDocument",
    dmmf: "PlatDocument",
    description:
      "Documents and captured notes, including extracted text and AI summaries. Searchable.",
    jobScoped: true,
  },
  comms: {
    model: "platComms",
    dmmf: "PlatComms",
    description: "Stakeholder communications: what was sent or is due to be sent, to whom.",
    jobScoped: true,
  },
  meeting_minutes: {
    model: "platConMeetingMinutes",
    dmmf: "PlatConMeetingMinutes",
    description: "Meeting minutes with attendees, raw text and extracted actions.",
    jobScoped: true,
  },
  weekly_reports: {
    model: "platConWeeklyReport",
    dmmf: "PlatConWeeklyReport",
    description: "Weekly client report drafts and their approval status.",
    jobScoped: true,
  },
  phase_evidence: {
    model: "platConPhaseEvidence",
    dmmf: "PlatConPhaseEvidence",
    description: "Evidence notes attached to a phase.",
    jobScoped: true,
  },
  bim_models: {
    model: "platConBimModel",
    dmmf: "PlatConBimModel",
    description: "Linked BIM/3D models.",
    jobScoped: true,
  },

  // ── Assessment and learning ────────────────────────────────────────────────
  assessments: {
    model: "platAssessment",
    dmmf: "PlatAssessment",
    description: "Intake/assessment drafts produced by the assessment engine.",
    jobScoped: true,
  },
  learning_rules: {
    model: "platLearningRule",
    dmmf: "PlatLearningRule",
    description: "Learning rules the assistant must follow. Owner-only.",
    jobScoped: false,
  },
  hypotheses: {
    model: "platHypothesis",
    dmmf: "PlatHypothesis",
    description: "Open learning hypotheses awaiting confirmation. Owner-only.",
    jobScoped: false,
  },
  corrections: {
    model: "platCorrection",
    dmmf: "PlatCorrection",
    description: "Human corrections of AI output — the learning loop's input. Owner-only.",
    jobScoped: true,
  },
  intelligence_snapshot: {
    model: "platIntelligenceSnapshot",
    dmmf: "PlatIntelligenceSnapshot",
    description:
      "Periodic learning-intelligence snapshot: top rules, known gaps and metrics. Owner-only.",
    jobScoped: false,
  },

  // ── Configuration and audit ────────────────────────────────────────────────
  settings: {
    model: "platCfgSetting",
    dmmf: "PlatCfgSetting",
    description: "Org configuration key/value settings.",
    jobScoped: false,
  },
  reference: {
    model: "platCfgReference",
    dmmf: "PlatCfgReference",
    description: "Reference data: zones, budget benchmarks and other lookup values.",
    jobScoped: false,
  },
  engagement_types: {
    model: "platEngagementTypeConfig",
    dmmf: "PlatEngagementTypeConfig",
    description: "Per-engagement-type configuration (phase template, cashflow period, tier).",
    jobScoped: false,
  },
  pending_writes: {
    model: "platPendingWrite",
    dmmf: "PlatPendingWrite",
    description: "AI-proposed record changes awaiting human approval.",
    jobScoped: true,
  },
  activity: {
    model: "platExecutionLog",
    dmmf: "PlatExecutionLog",
    description: "Execution log — every write and AI action, with actor and timestamp.",
    jobScoped: true,
  },
  chat_sessions: {
    model: "platChatSession",
    dmmf: "PlatChatSession",
    description: "Past assistant conversations: title, when they ran, and their close summary.",
    jobScoped: true,
  },
  chat_messages: {
    model: "platChatMessage",
    dmmf: "PlatChatMessage",
    description:
      "Messages within past conversations. Search this to answer 'what did we discuss about X?'.",
    jobScoped: false,
  },
} as const satisfies Record<string, TableDef>;

export const TABLE_KEYS = Object.keys(TABLES) as TableKey[];

/** Readable table → the recordWriter table the assistant may PROPOSE changes
 *  to. Absent = readable but not proposable.
 *
 *  Parity target: whatever a Claude session over the Airtable base could
 *  change, the assistant can propose changing — same tables, same fields. The
 *  omissions are deliberate and are not domain data: `activity` is the
 *  append-only audit log, `pending_writes` is the approval queue itself,
 *  `chat_*` is the assistant's own transcript, `settings`/`reference`/
 *  `engagement_types`/`team` are configuration and control-plane, and the
 *  learning stores (`hypotheses`, `corrections`, `intelligence_snapshot`) plus
 *  `assessments` are engine output written by their own services. `change_log`
 *  is the legacy mirror of `variations`, which IS proposable. */
export const WRITER_TABLE: Partial<Record<TableKey, WritableTable>> = {
  jobs: "job",
  actions: "action",
  decisions: "decision",
  phases: "phase",
  plan: "plan",
  workstreams: "workstream",
  budget_lines: "budget_line",
  cashflows: "cashflow",
  procurement: "procurement",
  variations: "variation_order",
  quotes: "quote",
  quote_lines: "quote_line",
  risks: "risk",
  contacts: "contact",
  vendors: "vendor",
  rooms: "room",
  documents: "document",
  comms: "comms",
  meeting_minutes: "meeting_minutes",
  weekly_reports: "weekly_report",
  phase_evidence: "phase_evidence",
  bim_models: "bim_model",
  learning_rules: "learning_rule",
};

/** Table keys the assistant may propose changes to. */
export const PROPOSABLE_KEYS = Object.keys(WRITER_TABLE) as TableKey[];

/** Bookkeeping columns the model never needs to reason about. Excluded from
 *  search and from `describe_data`, but still returned on rows so an id-based
 *  follow-up (get_record) always has what it needs. */
const NOISE_FIELDS = new Set(["airtableRecordId", "orgId"]);

export interface FieldInfo {
  name: string;
  type: string;
}

interface Resolved {
  key: TableKey;
  def: TableDef;
  fields: FieldInfo[];
  /** String columns worth a `contains` search — excludes bookkeeping ids. */
  searchable: string[];
  fieldNames: Set<string>;
}

const cache = new Map<TableKey, Resolved>();

function dmmfFields(modelName: string): FieldInfo[] {
  const m = Prisma.dmmf.datamodel.models.find((x) => x.name === modelName);
  if (!m) throw new Error(`Model "${modelName}" is not in the Prisma schema.`);
  return m.fields.filter((f) => f.kind === "scalar").map((f) => ({ name: f.name, type: f.type }));
}

export function resolveTable(key: string): Resolved | null {
  if (!(key in TABLES)) return null;
  const k = key as TableKey;
  const hit = cache.get(k);
  if (hit) return hit;
  const def = TABLES[k] as TableDef;
  const fields = dmmfFields(def.dmmf);
  const resolved: Resolved = {
    key: k,
    def,
    fields,
    searchable: fields
      .filter((f) => f.type === "String" && !NOISE_FIELDS.has(f.name))
      .map((f) => f.name),
    fieldNames: new Set(fields.map((f) => f.name)),
  };
  cache.set(k, resolved);
  return resolved;
}

/** The table listing handed to the model — the equivalent of an Airtable MCP
 *  `list_tables`, so it can see what exists before guessing at a name. */
export function tableCatalog(): Array<{
  table: TableKey;
  description: string;
  jobScoped: boolean;
  proposable: boolean;
}> {
  return TABLE_KEYS.map((k) => ({
    table: k,
    description: TABLES[k].description,
    jobScoped: TABLES[k].jobScoped,
    proposable: WRITER_TABLE[k] !== undefined,
  }));
}

/** Field list for one table, minus bookkeeping columns. */
export function tableFields(key: string): FieldInfo[] | null {
  const t = resolveTable(key);
  return t ? t.fields.filter((f) => !NOISE_FIELDS.has(f.name)) : null;
}

/** A one-line summary of the whole surface, cheap enough to sit in the system
 *  prompt so the model never has to spend a tool call discovering table names. */
export function catalogPromptLine(): string {
  return TABLE_KEYS.join(", ");
}
