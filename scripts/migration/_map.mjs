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

/** Month labels ("June 2025") and canonical "YYYY-MM" both normalize to
 *  YYYY-MM; rows with no usable period fall back to the record's Airtable
 *  createdTime month (Didi drift — 37 period-less CASHFLOWS rows). */
export function toPeriod(v, fallbackIso) {
  const s = String(v ?? "").trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (s) {
    const d = new Date(s);
    if (!isNaN(d)) return d.toISOString().slice(0, 7);
  }
  return String(fallbackIso ?? "").slice(0, 7);
}

export const TABLES = [
  {
    key: "contact", air: "CONTACTS", model: "platContact",
    fields: [
      f("name", "Contact_Name"), f("email", "Email"), f("phone", "Phone"),
      f("role", "Role"), f("notes", "Notes"),
    ],
    links: [],
    // Didi drift: contacts split into First_Name/Last_Name (+LinkedIn).
    deriveReads: ["First_Name", "Last_Name", "LinkedIn"],
    pgDerive: (fields) => {
      const out = {};
      const joined = [fields.First_Name, fields.Last_Name].filter(Boolean).join(" ");
      if (!fields.Contact_Name && joined) out.name = joined;
      if (fields.LinkedIn) out.notes = [fields.Notes, `LinkedIn: ${fields.LinkedIn}`].filter(Boolean).join(" · ");
      return out;
    },
    // PG-only: type/company/isActive have no CONTACTS field — lossy toward Air.
  },
  {
    key: "job", air: "JOBS", model: "platJob",
    // PlatJob.code is required with no default and JOBS has no code column —
    // derive a stable, unique code from the Airtable rec id (idempotent).
    fields: [
      f("name", "Job_Name"), f("summary", "Description"), f("status", "Status"),
      f("budgetTotal", "Estimated_Value", "num"),
      f("engagementType", "Engagement_Type"),
      f("scopeChangesCount", "Scope_Changes_Count", "num"),
      f("targetEndDate", "Target_Completion", "date"),
    ],
    links: [],
    // Didi drift: legacy outcome-tracking columns ride in PlatJob.meta JSON so
    // the history survives verbatim (no dedicated PG columns by design).
    deriveReads: ["Outcome", "Date_Estimated", "Date_Completed", "Actual_Value", "Variance_Percent", "Estimated_Summary", "Actual_Summary", "Root_Cause_of_Variance", "Learning_Rule_Candidate"],
    pgDerive: (fields, rec) => {
      const out = { code: `A-${String(rec?.id ?? "").slice(-6).toUpperCase()}` };
      // Engagement types arrive as display labels on live bases ("Short Job",
      // "Long Project") — the app switches on the snake_case union.
      if (fields.Engagement_Type) {
        out.engagementType = String(fields.Engagement_Type).toLowerCase().replace(/[\s-]+/g, "_").slice(0, 30);
      }
      const legacy = {};
      for (const k of ["Outcome", "Date_Estimated", "Date_Completed", "Actual_Value", "Variance_Percent", "Estimated_Summary", "Actual_Summary", "Root_Cause_of_Variance", "Learning_Rule_Candidate"]) {
        if (fields[k] !== undefined && fields[k] !== "") legacy[k] = fields[k];
      }
      if (Object.keys(legacy).length) out.meta = JSON.stringify({ airtableLegacy: legacy });
      return out;
    },
    // PG-only: code/healthScore/completionPct/startDate — Airtable JOBS is
    // thinner than PlatJob by design (see audit §3); lossy toward Air.
  },
  {
    key: "workstream", air: "WORKSTREAMS", model: "platWorkstream",
    fields: [
      f("name", "Workstream_Name"), f("description", "Description"),
      f("status", "Status"), f("milestone", "Next_Milestone"),
    ],
    links: [],
    // Didi drift: planning columns survive in notes as a labelled block.
    deriveReads: ["Priority", "Track", "Start_Date", "Target_Date", "Current_State"],
    pgDerive: (fields) => {
      const bits = [];
      for (const k of ["Priority", "Track", "Start_Date", "Target_Date", "Current_State"]) {
        if (fields[k] !== undefined && fields[k] !== "") bits.push(`${k}: ${fields[k]}`);
      }
      return bits.length ? { notes: bits.join(" · ") } : {};
    },
  },
  {
    key: "phase", air: "PHASES", model: "platConPhase",
    fields: [
      f("name", "Phase_Name"), f("status", "Status"),
      f("completionPct", "Completion_Pct", "num"), f("sortOrder", "Sort_Order", "num"),
      f("isAiDraft", "Is_AI_Draft", "bool"), f("approvedBy", "Approved_By"),
      f("rag", "RAG"),
      f("startDate", "Start_Date", "date"), f("endDate", "End_Date", "date"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
    // Didi drift: their PHASES orders by Sequence (no Sort_Order column).
    deriveReads: ["Sequence"],
    pgDerive: (fields) =>
      fields.Sort_Order === undefined && typeof fields.Sequence === "number"
        ? { sortOrder: fields.Sequence }
        : {},
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
    // Didi drift: Risk_Name instead of Risk; Probability (High/Medium/Low
    // select) instead of numeric Likelihood; Category/RAG/Notes preserved in
    // the description as a labelled suffix.
    deriveReads: ["Risk_Name", "Probability", "Category", "RAG", "Notes"],
    pgDerive: (fields) => {
      const out = {};
      if (!fields.Risk && fields.Risk_Name) out.description = String(fields.Risk_Name);
      if (fields.Likelihood === undefined && fields.Probability) {
        out.likelihood = { High: 4, Medium: 3, Low: 2 }[String(fields.Probability)] ?? 3;
      }
      const extra = [];
      for (const k of ["Category", "RAG", "Notes"]) {
        if (fields[k]) extra.push(`${k}: ${fields[k]}`);
      }
      if (extra.length) {
        out.description = `${out.description ?? String(fields.Risk ?? "")}\n[${extra.join(" · ")}]`;
      }
      return out;
    },
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
    // Didi drift: richer decision register — recover what has PG columns,
    // append the register-only context to rationale as a labelled block.
    deriveReads: ["Decision_Name", "Decision_Made", "Alternatives_Rejected", "Decision_Type", "Domain", "Context", "Reversibility", "Confidence", "Notes"],
    pgDerive: (fields) => {
      const out = {};
      if (!fields.Decision_Description) {
        const desc = fields.Decision_Made || fields.Decision_Name;
        if (desc) out.description = String(desc);
      }
      if (fields.Alternatives_Rejected) out.alternatives = String(fields.Alternatives_Rejected);
      const cat = fields.Decision_Type || fields.Domain;
      if (cat) out.category = String(cat).slice(0, 100);
      const extra = [];
      for (const k of ["Context", "Reversibility", "Confidence", "Notes"]) {
        if (fields[k] !== undefined && fields[k] !== "") extra.push(`${k}: ${fields[k]}`);
      }
      if (extra.length) {
        out.rationale = [fields.Rationale, `[${extra.join(" · ")}]`].filter(Boolean).join("\n");
      }
      return out;
    },
  },
  {
    key: "action", air: "ISSUES", model: "platActionHub",
    fields: [
      f("title", "Action_Name"), f("detail", "Description"),
      f("status", "Status", "str", { statusMap: "action" }),
      f("priority", "Priority", "str", { statusMap: "actionPriority" }),
      f("dueDate", "Due_Date", "date"),
      f("issueType", "Issue_Type"),
      // PG phaseId has no ISSUES home (canonical ISSUES carries no Phase
      // link) — lossy toward Air.
    ],
    links: [
      { pg: "jobId", air: "Job", target: "job" },
      { pg: "riskId", air: "RISKS", target: "risk" },
    ],
    // owner rides in Notes as "Owner: <name>" (fieldMaps convention).
    airDerive: (row) =>
      row.owner && String(row.owner).trim() ? { Notes: `Owner: ${String(row.owner).trim()}` } : {},
    // Didi drift: Trigger_Condition/Completion_Date + free-form Notes survive
    // in the context JSON column (recordWriter's context field).
    deriveReads: ["Trigger_Condition", "Completion_Date", "Notes"],
    pgDerive: (fields) => {
      const out = {};
      const m = /^Owner:\s*(.+)$/.exec(String(fields.Notes ?? ""));
      if (m) out.owner = m[1];
      const legacy = {};
      if (fields.Trigger_Condition) legacy.triggerCondition = fields.Trigger_Condition;
      if (fields.Completion_Date) legacy.completionDate = fields.Completion_Date;
      if (fields.Notes && !m) legacy.notes = fields.Notes;
      if (Object.keys(legacy).length) out.context = JSON.stringify({ airtableLegacy: legacy });
      return out;
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
      f("qty", "Quantity", "num"),
      f("unitPrice", "Unit_Cost", "num"), f("status", "Status"),
      f("dueDate", "Expected_Date", "date"),
      // PROCUREMENT.Total_Cost is a formula — never written; PG total recomputed
      // by the app. PG category/vendorName are text; Air Supplier/Budget_Category
      // are links the app doesn't wire — skipped both ways.
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
    deriveReads: ["Procurement_Name"],
    pgDerive: (fields) => ({ item: String(fields.Procurement_Name ?? "").slice(0, 300) }),
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
      f("amount", "Amount", "num"), f("notes", "Notes"),
    ],
    links: [{ pg: "jobId", air: "Job", target: "job" }],
    // Didi drift: Period arrives as a month label ("June 2025") and 37 rows
    // carry none (fallback: createdTime month); long labels overflow the
    // VarChar columns, so every short text column is sliced to its width.
    deriveReads: ["Cashflow_Name", "Period", "Type", "Source_Or_Payee", "Category", "Status"],
    pgDerive: (fields, rec) => ({
      name: String(fields.Cashflow_Name ?? "").slice(0, 200),
      period: toPeriod(fields.Period, rec?.createdTime),
      type: String(fields.Type ?? "Out") === "In" ? "In" : "Out",
      sourceOrPayee: String(fields.Source_Or_Payee ?? "").slice(0, 200),
      category: String(fields.Category ?? "").slice(0, 100),
      status: String(fields.Status ?? "Forecast").slice(0, 20),
    }),
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
    // Didi drift: legacy rules lack Instance codes (derive a stable one) and
    // keep their text in Operational_Directive rather than Rule_Description.
    deriveReads: ["Rule_Name"],
    pgDerive: (fields, rec) => {
      const out = {};
      if (!fields.Instance) out.ruleCode = ("LRN-" + String(rec?.id ?? "").slice(-6).toUpperCase()).slice(0, 20);
      if (!fields.Rule_Description) {
        const d = fields.Operational_Directive || fields.Rule_Name;
        if (d) out.description = String(d);
      }
      // Legacy Rule_Type values are prose; PG kind is the guidance/adjustment
      // enum (VarChar(20)). Lock columns sliced to width defensively.
      if (fields.Rule_Type) {
        out.kind = String(fields.Rule_Type).toLowerCase().includes("adjust") ? "adjustment" : "guidance";
      }
      if (fields.Override_Level) out.overrideLevel = String(fields.Override_Level).toLowerCase().replace(/[\s-]+/g, "_").slice(0, 30);
      if (fields.Application_Window) out.applicationWindow = String(fields.Application_Window).slice(0, 50);
      return out;
    },
    airDerive: (row) => ({ Rule_Name: String(row.description ?? "").slice(0, 120) || "Untitled rule" }),
  },
  // ── Phase 4 additions (owner decisions 2026-07-29): CHANGE_LOG modelled;
  //    learning loop, audit + chat streams migrate. DOMAIN_LABELS/REGIONS
  //    dropped (never modelled — decision recorded in migration-progress). ──
  {
    // Non-variation change rows — the complement of variation_order's filter.
    key: "change_log", air: "CHANGE_LOG", model: "platConChangeLog",
    fields: [
      f("name", "Change_Name"), f("changeType", "Change_Type"),
      f("description", "Description"), f("status", "Status"),
      f("impactCost", "Impact_Cost", "num"), f("impactDays", "Impact_Schedule_Days", "num"),
      f("dateRaised", "Date_Raised", "date"), f("dateResolved", "Date_Resolved", "date"),
      f("raisedBy", "Raised_By"), f("notes", "Notes"),
    ],
    links: [
      { pg: "jobId", air: "Job", target: "job" },
      { pg: "phaseId", air: "Phase", target: "phase" },
      { pg: "linkedIssueId", air: "Linked_Issue", target: "action" },
    ],
    airFilter: (fields) => fields.Change_Type !== "Variation",
  },
  {
    // Mapping mirrors learning.ts airHypothesis(): app-only columns ride in
    // the Evidence JSON; description prefers Summary_of_Findings.
    key: "hypothesis", air: "HYPOTHESES", model: "platHypothesis",
    deriveReads: ["Evidence", "Summary_of_Findings", "Hypothesis_Name", "Hypothesis_Type"],
    fields: [
      f("status", "Status"), f("sampleCount", "Evidence_Count", "num"),
      f("confidence", "Confidence", "num"), f("reviewedAt", "Date_Closed", "date"),
    ],
    links: [],
    pgDerive: (fields) => {
      let meta = {};
      try { meta = JSON.parse(String(fields.Evidence ?? "{}")) || {}; } catch { /* legacy */ }
      return {
        description: String(fields.Summary_of_Findings ?? "") || String(fields.Hypothesis_Name ?? ""),
        dimension: String(meta.dimension ?? ""),
        rootCausePattern: String(meta.rootCausePattern ?? ""),
        triggerCondition: String(meta.triggerCondition ?? "") || "{}",
        avgVariancePct: typeof meta.avgVariancePct === "number" ? meta.avgVariancePct : 0,
      };
    },
    airDerive: (row) => ({
      Hypothesis_Name: String(row.description ?? "").slice(0, 120) || "Hypothesis",
      Summary_of_Findings: String(row.description ?? ""),
      Evidence: JSON.stringify({
        dimension: row.dimension, rootCausePattern: row.rootCausePattern,
        avgVariancePct: row.avgVariancePct, triggerCondition: row.triggerCondition,
      }),
    }),
  },
  {
    // Mapping mirrors corrections.ts emitCorrection() / learning.ts
    // airCorrection(): first-class Spec-12 columns win; app metadata rides in
    // the Notes JSON.
    key: "correction", air: "CORRECTIONS", model: "platCorrection",
    deriveReads: ["Notes", "Description"],
    fields: [
      f("dimension", "Field_Corrected"), f("rootCause", "Root_Cause"),
      f("aiValueText", "AI_Output"), f("humanValueText", "Human_Correction"),
      f("variancePct", "Variance_Percent", "num"), f("correctedBy", "Corrected_By"),
      f("sourceModule", "Source_Module"), f("correctionDirection", "Correction_Direction"),
    ],
    links: [{ pg: "hypothesisId", air: "Hypothesis", target: "hypothesis" }],
    pgDerive: (fields) => {
      let n = {};
      try { n = JSON.parse(String(fields.Notes ?? "{}")) || {}; } catch { /* legacy */ }
      return {
        entityType: String(n.entityType ?? ""),
        context: n.context && typeof n.context === "object" ? JSON.stringify(n.context) : "{}",
        sourceModule: String(fields.Source_Module ?? "") || String(n.sourceModule ?? ""),
        correctionDirection: String(fields.Correction_Direction ?? "") || String(n.direction ?? ""),
      };
    },
  },
  {
    // Mapping mirrors learning.ts snapshotIntelligence(): rich app metrics
    // ride in the Accuracy_Summary JSON.
    key: "intelligence_snapshot", air: "INTELLIGENCE_SNAPSHOT", model: "platIntelligenceSnapshot",
    noCreatedAt: true, // model keys on capturedAt
    deriveReads: ["Accuracy_Summary", "Known_Gaps"],
    fields: [
      f("capturedAt", "Snapshot_Date", "date"),
      f("completedJobs", "Total_Jobs_Completed", "num"),
      f("activeRules", "Total_Active_Rules", "num"),
    ],
    links: [],
    pgDerive: (fields) => {
      let m = {};
      try { m = JSON.parse(String(fields.Accuracy_Summary ?? "{}")) || {}; } catch { /* legacy */ }
      return {
        accuracyRatePct: typeof m.accuracyRatePct === "number" ? m.accuracyRatePct : null,
        autoApplyRules: typeof m.autoApplyRules === "number" ? m.autoApplyRules : 0,
        avgConfidence: typeof m.avgConfidence === "number" ? m.avgConfidence : 0,
        totalJobs: typeof m.totalJobs === "number" ? m.totalJobs : 0,
        topRules: Array.isArray(m.topRules) ? JSON.stringify(m.topRules) : "[]",
        gaps: Array.isArray(m.gaps) ? JSON.stringify(m.gaps) : "[]",
        metrics: JSON.stringify(m ?? {}),
        notes: String(fields.Known_Gaps ?? ""),
      };
    },
  },
  {
    // Chat/audit history migrates (owner decision 2026-07-29). Job_Id /
    // Session_Id are TEXT fields on the Airtable side (not record links) —
    // `text: true` links resolve a bare id string through the same recMaps.
    key: "chat_session", air: "CHAT_SESSIONS", model: "platChatSession",
    noCreatedAt: true, // model keys on startedAt
    fields: [
      f("title", "Session_Title"),
      f("startedAt", "Started_At", "date"), f("endedAt", "Ended_At", "date"),
      f("summary", "Summary"),
    ],
    links: [{ pg: "jobId", air: "Job_Id", target: "job", text: true }],
  },
  {
    key: "chat_message", air: "CHAT_MESSAGES", model: "platChatMessage",
    fields: [
      f("role", "Role"), f("content", "Content"), f("toolCalls", "Tool_Calls"),
      f("createdAt", "Created_At", "date"),
    ],
    // sessionId is NOT NULL: rows whose session didn't resolve skip + log.
    links: [{ pg: "sessionId", air: "Session_Id", target: "chat_session", text: true }],
  },
  {
    // Audit trail migrates (owner decision 2026-07-29): compliance-relevant.
    // Airtable EXECUTION_LOG is thinner than PlatExecutionLog — the app's rich
    // columns (payload/operation/actor) are packed into Summary JSON by
    // recordWriter's Airtable branch where present; canonical columns map 1:1.
    key: "execution_log", air: "EXECUTION_LOG", model: "platExecutionLog",
    fields: [
      f("payload", "Summary"), f("targetTable", "Tables_Affected"),
      f("status", "Status"), f("executedAt", "Date_Time", "date"),
    ],
    links: [],
    deriveReads: ["Action_Type", "Initiated_By", "Log_Entry"],
    pgDerive: (fields) => ({
      operation: String(fields.Action_Type ?? "").toLowerCase().slice(0, 30),
      targetTable: String(fields.Tables_Affected ?? "").slice(0, 100),
      status: String(fields.Status ?? "executed").slice(0, 20),
      actorType: String(fields.Initiated_By ?? "") === "AI" ? "ai" : String(fields.Initiated_By ?? "") === "System" ? "system" : "human",
      actorName: String(fields.Initiated_By ?? ""),
      result: String(fields.Log_Entry ?? ""),
    }),
  },
  // ── Phase 5 drift reconciliation (found on the live bases) ────────────────
  {
    // Didi predates the VENDORS table: their vendor directory lives in the
    // Core ORGANISATIONS table (Type="Vendor", 47 real rows). Bases WITH a
    // VENDORS table migrate it via the `vendor` entry above; both land in
    // PlatConVendor (rec-id idempotency keeps re-runs safe either way).
    key: "org_directory", air: "ORGANISATIONS", model: "platConVendor",
    fields: [f("name", "Organisation_Name"), f("category", "Industry")],
    links: [],
    airFilter: (fields) => fields.Type === "Vendor",
    deriveReads: ["Type", "Org_Status", "Address", "Notes"],
    pgDerive: (fields) => ({
      isActive: String(fields.Org_Status ?? "Active") === "Active",
      notes: [fields.Address, fields.Notes].filter(Boolean).join(" · "),
    }),
  },
  {
    key: "engagement_type_config", air: "ENGAGEMENT_TYPE_CONFIG", model: "platEngagementTypeConfig",
    fields: [
      f("configName", "Config_Name"), f("phaseTemplate", "Phase_Template"),
      f("planView", "Plan_View"), f("fullRiskRegister", "Full_Risk_Register", "bool"),
      f("cashflowPeriod", "Cashflow_Period"), f("notes", "Notes"),
      f("active", "Active", "bool"), f("portfolioView", "Portfolio_View", "bool"),
    ],
    links: [],
    deriveReads: ["Engagement_Type"],
    pgDerive: (fields) => ({
      engagementType: String(fields.Engagement_Type ?? "long_project")
        .toLowerCase()
        .replace(/[\s-]+/g, "_")
        .slice(0, 30),
    }),
  },
  {
    key: "plat_cfg_reference", air: "PLAT_CFG_REFERENCE", model: "platCfgReference",
    fields: [
      f("type", "Ref_Type"), f("code", "Code"), f("name", "Name"), f("value", "Value"),
      f("sortOrder", "Sort_Order", "num"), f("isActive", "Is_Active", "bool"),
    ],
    links: [],
  },
  {
    key: "plat_cfg_setting", air: "PLAT_CFG_SETTING", model: "platCfgSetting",
    noCreatedAt: true, // model has updatedAt only
    fields: [f("key", "Setting_Key"), f("value", "Value")],
    links: [],
  },
  {
    // Construction-extension reference tables have no dedicated PG models —
    // the governance framework classes their content as CUSTOMER CONFIG, so
    // they land in PlatCfgReference under stable ref types.
    key: "ref_zone", air: "REF_ZONES", model: "platCfgReference",
    fields: [],
    links: [],
    deriveReads: ["Zone_Code", "Zone_Name", "Construction_Focus", "Active"],
    pgDerive: (fields) => ({
      type: "zone",
      code: String(fields.Zone_Code ?? ""),
      name: String(fields.Zone_Name ?? ""),
      value: JSON.stringify({ constructionFocus: fields.Construction_Focus ?? "" }),
      isActive: fields.Active !== false,
    }),
  },
  {
    key: "ref_budget", air: "REF_BUDGET", model: "platCfgReference",
    fields: [],
    links: [],
    deriveReads: ["Classification_Code", "Classification_Name", "Contract_Type", "Reporting_Group", "Approval_Required", "Notes"],
    pgDerive: (fields) => ({
      type: "budget_category",
      code: String(fields.Classification_Code ?? ""),
      name: String(fields.Classification_Name ?? ""),
      value: JSON.stringify({
        contractType: fields.Contract_Type ?? "",
        reportingGroup: fields.Reporting_Group ?? "",
        approvalRequired: fields.Approval_Required === true,
        notes: fields.Notes ?? "",
      }),
      isActive: true,
    }),
  },
];

// Excluded from v1, with reasons (surface these in every run's output):
export const EXCLUDED = [
  { air: "PENDING_WRITES", reason: "the Postgres claim registry (PlatPendingWrite) was ALWAYS authoritative — the Airtable table is a shadow; nothing to migrate." },
  { air: "DOMAIN_LABELS / REGIONS", reason: "dropped (owner decision 2026-07-29) — never modelled in PG; vocabulary/regions are code- or config-driven post-migration." },
  { air: "TEAM / control-base PLAT_*", reason: "control plane — migrated separately by scripts/migration/airtable-control-to-pg.mjs into the CONTROL database." },
];
