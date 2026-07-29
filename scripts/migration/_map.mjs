// Airtable↔Postgres migration table map (backend-switch audit Phase C).
//
// Hand-derived from the two authorities and kept in sync with them BY HAND:
//   - src/lib/airtable/fieldMaps.ts  (app/Prisma key → Airtable field name)
//   - prisma/schema.prisma           (Prisma field names; Phase B models)
// recordWriter's invariant makes this 1:1 for delegate-backed tables: the zod
// payload keys ARE the Prisma column names. Exceptions are encoded below
// (learning_rule is hand-mapped; cashflow is excluded — see notes).
//
// TABLES is in TOPOLOGICAL order: link targets always precede their linkers.
// `fields`: scalar copies. kind: str|num|bool|date (drives coercion each way).
//   - statusMap: app/PG value → Airtable option name (reversed automatically).
//   - airOnly: exists in Airtable but not PG (skip toward PG, derive toward Air).
// `links`: Airtable link field (array of rec ids) ↔ PG Int FK, resolved via the
// airtableRecordId bridge column. `selfLinks` are patched in a second pass.
// `airDerive`: extra Airtable cells computed from the PG row on create.
// `airFilter`: Air→PG row filter (e.g. CHANGE_LOG carries non-variation rows).

const inv = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));

export const STATUS_MAPS = {
  decision: { proposed: "Pending", confirmed: "Approved", superseded: "Reversed" },
  action: { open: "Open", in_progress: "In Progress", done: "Closed", deferred: "Deferred" },
  actionPriority: { P1: "High", P2: "Medium", P3: "Low" },
  comms: { pending: "Pending", sent: "Sent", acknowledged: "Acknowledged", overdue: "Overdue" },
  variation: { draft: "Proposed", submitted: "Pending", approved: "Approved", rejected: "Rejected" },
};
export const REVERSE_STATUS_MAPS = Object.fromEntries(
  Object.entries(STATUS_MAPS).map(([k, m]) => [k, inv(m)]),
);

const f = (pg, air, kind = "str", extra = {}) => ({ pg, air, kind, ...extra });

export const TABLES = [
  {
    key: "contact", air: "CONTACTS", model: "platContact",
    fields: [
      f("name", "Contact_Name"), f("email", "Email"), f("phone", "Phone"),
      f("role", "Role"), f("notes", "Notes"),
    ],
    links: [],
    // PG-only: type/company/isActive have no CONTACTS field — lossy toward Air.
  },
  {
    key: "job", air: "JOBS", model: "platJob",
    fields: [
      f("name", "Job_Name"), f("summary", "Description"), f("status", "Status"),
      f("budgetTotal", "Estimated_Value", "num"),
      f("engagementType", "Engagement_Type"),
      f("scopeChangesCount", "Scope_Changes_Count", "num"),
    ],
    links: [],
    // PG-only: code/healthScore/completionPct/dates/meta — Airtable JOBS is
    // thinner than PlatJob by design (see audit §3); lossy toward Air.
  },
  {
    key: "workstream", air: "WORKSTREAMS", model: "platWorkstream",
    fields: [
      f("name", "Workstream_Name"), f("description", "Description"),
      f("status", "Status"), f("milestone", "Next_Milestone"),
    ],
    links: [],
  },
  {
    key: "phase", air: "PHASES", model: "platConPhase",
    fields: [
      f("name", "Phase_Name"), f("status", "Status"),
      f("completionPct", "Completion_Pct", "num"), f("sortOrder", "Sort_Order", "num"),
      f("isAiDraft", "Is_AI_Draft", "bool"), f("approvedBy", "Approved_By"),
      // PHASES.RAG is pgOmit'd (no PG column) — Airtable-only, dropped toward PG.
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    key: "document", air: "DOCUMENTS", model: "platDocument",
    fields: [
      f("title", "Document_Name"), f("docType", "Document_Type"),
      f("storageRef", "Drive_URL"), f("status", "Doc_Status"),
      f("uploadedBy", "Uploaded_By"), f("storageProvider", "Storage_Provider"),
      f("textContent", "Text_Content"), f("aiSummary", "AI_Summary"),
      f("aiAnalysis", "AI_Analysis"), f("confidence", "Confidence", "num"),
      f("analyzedAt", "Analyzed_At", "date"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
    airDerive: (row) => ({ Upload_Date: row.createdAt?.toISOString?.() ?? undefined }),
    // DOCUMENTS.File attachments: Drive_URL refs only — binaries not restaged.
  },
  {
    key: "vendor", air: "VENDORS", model: "platConVendor",
    fields: [
      f("name", "Vendor_Name"), f("category", "Category"),
      f("contactName", "Contact_Name"), f("contactEmail", "Contact_Email"),
      f("contactPhone", "Contact_Phone"), f("rating", "Rating", "num"),
      f("notes", "Notes"), f("isActive", "Is_Active", "bool"),
    ],
    links: [],
  },
  {
    key: "risk", air: "RISKS", model: "platConRisk",
    fields: [
      f("description", "Risk"), f("likelihood", "Likelihood", "num"),
      f("impact", "Impact", "num"), f("mitigation", "Mitigation"),
      f("owner", "Owner"), f("status", "Status"),
      f("escalatedAt", "Escalated_At", "date"), f("escalationNote", "Escalation_Note"),
      f("createdByAi", "Created_By_AI", "bool"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    key: "decision", air: "DECISIONS", model: "platDecision",
    fields: [
      f("description", "Decision_Description"), f("rationale", "Rationale"),
      f("status", "Status", "str", { statusMap: "decision" }),
      f("decidedAt", "Decision_Date", "date"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
    airDerive: (row) => ({ Decision_Name: String(row.description ?? "").slice(0, 120) || "Untitled decision" }),
    // PG-only: alternatives/category/madeBy/source* — lossy toward Air.
  },
  {
    key: "action", air: "ISSUES", model: "platActionHub",
    fields: [
      f("title", "Action_Name"), f("detail", "Description"),
      f("status", "Status", "str", { statusMap: "action" }),
      f("priority", "Priority", "str", { statusMap: "actionPriority" }),
      f("dueDate", "Due_Date", "date"),
      // ISSUES.Issue_Type + RISKS link are pgOmit'd — Airtable-only.
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
    // owner rides in Notes as "Owner: <name>" (fieldMaps convention).
    airDerive: (row) =>
      row.owner && String(row.owner).trim() ? { Notes: `Owner: ${String(row.owner).trim()}` } : {},
    pgDerive: (fields) => {
      const m = /^Owner:\s*(.+)$/.exec(String(fields.Notes ?? ""));
      return m ? { owner: m[1] } : {};
    },
  },
  {
    key: "assessment", air: "ASSESSMENTS", model: "platAssessment",
    fields: [
      f("name", "Assessment_Name"), f("engagementType", "Engagement_Type"),
      f("address", "Address"), f("suburb", "Suburb"), f("sizeSqm", "Size_Sqm", "num"),
      f("scope", "Scope"), f("result", "Result"), f("status", "Status"),
      f("promptVersion", "Prompt_Version"), f("createdBy", "Created_By"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    key: "quote", air: "QUOTES", model: "platConQuote",
    fields: [
      f("title", "Title"), f("refNumber", "Ref_Number"), f("clientName", "Client_Name"),
      f("status", "Status"), f("gstRate", "GST_Rate", "num"), f("subtotal", "Subtotal", "num"),
      f("gstAmount", "GST_Amount", "num"), f("total", "Total", "num"),
      f("notes", "Notes"), f("validUntil", "Valid_Until", "date"),
    ],
    links: [
      { pg: "jobId", air: "Job", target: "job" },
      { pg: "assessmentId", air: "Assessment", target: "assessment" },
    ],
  },
  {
    key: "quote_line", air: "QUOTE_LINES", model: "platConQuoteLine",
    fields: [
      f("description", "Description"), f("category", "Category"), f("qty", "Qty", "num"),
      f("unit", "Unit"), f("unitPrice", "Unit_Price", "num"),
      f("lineTotal", "Line_Total", "num"), f("sortOrder", "Sort_Order", "num"),
    ],
    links: [{ pg: "quoteId", air: "Quote", target: "quote" }],
  },
  {
    key: "budget_line", air: "BUDGET", model: "platConBudgetLine",
    fields: [
      f("category", "Budget_Category"), f("budgetAmount", "Estimated", "num"),
      f("description", "Notes"),
      // BUDGET.Actual is a rollup (read-only) and Forecast/RAG have no PG
      // column; PG committedAmount/actualAmount have no writable Air home.
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    key: "procurement", air: "PROCUREMENT", model: "platConProcurement",
    fields: [
      f("item", "Procurement_Name"), f("qty", "Quantity", "num"),
      f("unitPrice", "Unit_Cost", "num"), f("status", "Status"),
      f("dueDate", "Expected_Date", "date"),
      // PROCUREMENT.Total_Cost is a formula — never written; PG total recomputed
      // by the app. PG category/vendorName are text; Air Supplier/Budget_Category
      // are links the app doesn't wire — skipped both ways.
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    // Spec 12 per-transaction ledger → PlatConCashflowLedger (migration-plan
    // Phase 2; mover-v1 excluded it because the only PG model was the legacy
    // monthly PlatConCashflow shape). Status passes through untranslated: the
    // app enum (Forecast/Confirmed/Paid/Overdue) may be a subset of drifted
    // live-base options (fieldMaps' createDefault is "Scheduled") — drifted
    // values surface in Phase 5 reconciliation instead of silent coercion.
    // jobId is NOT NULL in PG: rows with no Job link are skipped + logged.
    key: "cashflow", air: "CASHFLOWS", model: "platConCashflowLedger",
    fields: [
      f("name", "Cashflow_Name"), f("period", "Period"), f("type", "Type"),
      f("amount", "Amount", "num"), f("sourceOrPayee", "Source_Or_Payee"),
      f("category", "Category"), f("status", "Status"), f("notes", "Notes"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    key: "variation_order", air: "CHANGE_LOG", model: "platConVariationOrder",
    fields: [
      f("title", "Change_Name"), f("refNumber", "Ref_Number"), f("description", "Description"),
      f("scopeChange", "Scope_Change"), f("costImpact", "Impact_Cost", "num"),
      f("timeImpactDays", "Impact_Schedule_Days", "num"),
      f("status", "Status", "str", { statusMap: "variation" }),
      f("isAiDrafted", "Is_AI_Drafted", "bool"), f("aiDraft", "AI_Draft"),
      f("submittedBy", "Raised_By"), f("approvedBy", "Approved_By"),
      f("approvedAt", "Date_Resolved", "date"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
    airDerive: (row) => ({
      Change_Type: "Variation",
      Date_Raised: row.createdAt?.toISOString?.().slice(0, 10) ?? undefined,
    }),
    // CHANGE_LOG also carries non-variation change rows — only variations map
    // to PlatConVariationOrder.
    airFilter: (fields) => fields.Change_Type === "Variation",
  },
  {
    key: "room", air: "ROOM_MATRIX", model: "platConRoomMatrix",
    fields: [
      f("name", "Room_Name"), f("zone", "Zone"), f("areaSqm", "Area_Sqm", "num"),
      f("ceilingHeight", "Ceiling_Height"), f("finishes", "Finishes"), f("notes", "Notes"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    key: "meeting_minutes", air: "MEETING_MINUTES", model: "platConMeetingMinutes",
    fields: [
      f("title", "Title"), f("meetingDate", "Meeting_Date", "date"), f("attendees", "Attendees"),
      f("rawMinutes", "Raw_Minutes"), f("extractedActions", "Extracted_Actions"),
      f("actionsCount", "Actions_Count", "num"), f("status", "Status"),
      f("confirmedAt", "Confirmed_At", "date"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    key: "weekly_report", air: "WEEKLY_REPORTS", model: "platConWeeklyReport",
    fields: [
      f("title", "Title"), f("weekEnding", "Week_Ending", "date"), f("content", "Content"),
      f("isAiGenerated", "Is_AI_Generated", "bool"), f("status", "Status"),
      f("approvedBy", "Approved_By"), f("approvedAt", "Approved_At", "date"),
      f("sentAt", "Sent_At", "date"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    key: "bim_model", air: "BIM_MODELS", model: "platConBimModel",
    fields: [
      f("name", "Name"), f("provider", "Provider"), f("embedUrl", "Embed_URL"),
      f("clientVisible", "Client_Visible", "bool"), f("addedBy", "Added_By"), f("notes", "Notes"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
  },
  {
    key: "phase_evidence", air: "PHASE_EVIDENCE", model: "platConPhaseEvidence",
    fields: [f("note", "Note"), f("addedBy", "Added_By")],
    links: [
      { pg: "phaseId", air: "Phase", target: "phase" },
      { pg: "documentId", air: "Document", target: "document" },
      { pg: "jobId", air: "Job", target: "job" },
    ],
  },
  {
    key: "comms", air: "COMMS", model: "platComms",
    fields: [
      f("topic", "Topic"), f("messageType", "Message_Type"), f("stakeholderRole", "Stakeholder_Role"),
      f("status", "Status", "str", { statusMap: "comms" }),
      f("dueDate", "Due_Date", "date"), f("sentBy", "Sent_By"), f("notes", "Notes"),
    ],
    links: [
      { pg: "jobId", air: "Job", target: "job" },
      { pg: "stakeholderId", air: "Stakeholder", target: "contact" },
      { pg: "phaseId", air: "Phase", target: "phase" },
      { pg: "linkedIssueId", air: "Linked_Issue", target: "action" },
      { pg: "linkedDecisionId", air: "Linked_Decision", target: "decision" },
    ],
  },
  {
    key: "plan", air: "PLAN", model: "platConPlanTask",
    fields: [
      f("name", "Task_Name"), f("status", "Status"), f("rag", "RAG"),
      f("startDate", "Start_Date", "date"), f("endDate", "End_Date", "date"),
      f("durationDays", "Duration_Days", "num"), f("notes", "Notes"),
    ],
    links: [
      { pg: "jobId", air: "Job", target: "job" },
      { pg: "phaseId", air: "Phase", target: "phase" },
    ],
    // Predecessor is a self-link → resolved in a second pass after all PLAN
    // rows exist on the target side. Assigned_To links TEAM (not migrated).
    selfLinks: [{ pg: "predecessorId", air: "Predecessor" }],
  },
  {
    key: "learning_rule", air: "LEARNING_RULES", model: "platLearningRule",
    // Hand-mapped: recordWriter routes creates through createRuleWithCode, so
    // the zod keys ≠ Prisma columns here. Bool-valued selects use boolMap.
    fields: [
      f("ruleCode", "Instance"), f("description", "Rule_Description"),
      f("kind", "Rule_Type"),
      f("isActive", "Rule_Status", "bool", { boolMap: { true: "Published", false: "Draft" } }),
      f("autoApply", "Applies_To", "bool", { boolMap: { true: "AI Layer Only", false: "Owner Review" } }),
      f("triggerCondition", "Trigger_Context"), f("adjustment", "Operational_Directive"),
      f("priority", "Priority", "num"), f("confidence", "Confidence_Level", "num"),
      f("timesTriggered", "Times_Triggered", "num"),
      f("cannotOverride", "Override_Permission", "bool", { invert: true }),
      f("dateActivated", "Date_Issued", "date"),
      f("overrideLevel", "Override_Level"), f("applicationWindow", "Application_Window"),
    ],
    links: [], // Related_Hypothesis → HYPOTHESES is out of scope for v1.
    airDerive: (row) => ({ Rule_Name: String(row.description ?? "").slice(0, 120) || "Untitled rule" }),
  },
];

// Excluded from v1, with reasons (surface these in every run's output):
export const EXCLUDED = [
  { air: "CASHFLOWS", reason: "PlatConCashflow is the legacy monthly shape (period/projected/actual); the Spec-12 per-transaction ledger has no PG model yet — needs a schema decision first." },
  { air: "HYPOTHESES / CORRECTIONS / INTELLIGENCE_SNAPSHOT", reason: "written outside recordWriter; add map entries once field-name parity is confirmed." },
  { air: "CHAT_SESSIONS / CHAT_MESSAGES / EXECUTION_LOG / PENDING_WRITES", reason: "audit/runtime streams; migrate deliberately, not by default." },
  { air: "TEAM / control-base PLAT_*", reason: "identity + control plane; PlatCtl* mirrors exist (Phase B) but sync is a separate, cross-org concern." },
];
