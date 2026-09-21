// Parity guarantees for the assistant's read surface.
//
// The failure these lock down is not a crash — it is the assistant confidently
// saying "that isn't tracked" about data sitting in the tenant database,
// because the table was never in its catalog. That is exactly the gap between
// our chat assistant and a Claude session pointed at the Airtable base, so the
// coverage assertion below is the load-bearing one: every model the migration
// writes into must be readable.

import { describe, expect, it } from "vitest";
import { requiredCreateFields, writableFields } from "@/lib/platform/recordWriter";
import { buildFilters } from "./executor";
import { roleCanProposeOn, roleCanQueryTable } from "./tools";
import { TABLE_KEYS, WRITER_TABLE, resolveTable, tableCatalog, tableFields } from "./dataCatalog";

/** Prisma models the Airtable→Postgres mover writes into (scripts/migration/
 *  _map.mjs). If the migration lands rows in a model, the assistant has to be
 *  able to read it — otherwise the data is in Supabase but invisible in chat. */
const MIGRATED_MODELS = [
  "platContact",
  "platJob",
  "platWorkstream",
  "platConPhase",
  "platDocument",
  "platConVendor",
  "platConRisk",
  "platDecision",
  "platActionHub",
  "platAssessment",
  "platConQuote",
  "platConQuoteLine",
  "platConBudgetLine",
  "platConProcurement",
  "platConCashflowLedger",
  "platConVariationOrder",
  "platConRoomMatrix",
  "platConMeetingMinutes",
  "platConWeeklyReport",
  "platConBimModel",
  "platConPhaseEvidence",
  "platComms",
  "platConPlanTask",
  "platLearningRule",
  "platConChangeLog",
  "platHypothesis",
  "platCorrection",
  "platIntelligenceSnapshot",
  "platExecutionLog",
  "platEngagementTypeConfig",
  "platCfgReference",
  "platCfgSetting",
  "platChatSession",
  "platChatMessage",
] as const;

describe("readable data surface", () => {
  const models = new Set(TABLE_KEYS.map((k) => resolveTable(k)!.def.model));

  it("covers every model the Airtable migration writes into", () => {
    const missing = MIGRATED_MODELS.filter((m) => !models.has(m));
    expect(missing, `migrated but unreadable: ${missing.join(", ")}`).toEqual([]);
  });

  it("reads cashflows from the Spec 12 ledger, not the empty legacy table", () => {
    // The migration lands CASHFLOWS in platConCashflowLedger. Pointing the read
    // at platConCashflow returned an empty array for a fully-populated ledger.
    expect(resolveTable("cashflows")!.def.model).toBe("platConCashflowLedger");
  });

  it("resolves every table to a real model with fields", () => {
    for (const key of TABLE_KEYS) {
      const t = resolveTable(key)!;
      expect(t.fields.length, key).toBeGreaterThan(0);
      expect(t.fieldNames.has("id"), key).toBe(true);
      // Something has to be searchable, or free-text lookups silently no-op.
      expect(t.searchable.length, `${key} has no text column to search`).toBeGreaterThan(0);
    }
  });

  it("marks job-scoped tables exactly when the model carries a jobId", () => {
    for (const key of TABLE_KEYS) {
      const t = resolveTable(key)!;
      expect(t.def.jobScoped, key).toBe(t.fieldNames.has("jobId"));
    }
  });

  it("rejects unknown tables rather than guessing", () => {
    expect(resolveTable("not_a_table")).toBeNull();
    expect(tableFields("not_a_table")).toBeNull();
  });

  it("describes every table it lists", () => {
    for (const entry of tableCatalog()) {
      expect(entry.description.length, entry.table).toBeGreaterThan(10);
    }
  });
});

describe("filters cannot reach past the tenancy or RLS predicates", () => {
  it("drops orgId, jobId and id — the scoping columns", () => {
    const { accepted, rejected } = buildFilters("actions", {
      orgId: 99,
      jobId: 1234,
      id: 7,
      status: "open",
    });
    // The org-isolation guard would still catch an unscoped query, but the
    // point is that a filter never gets to overwrite a scoped one.
    expect(accepted).toEqual({ status: "open" });
    expect(rejected.sort()).toEqual(["id", "jobId", "orgId"]);
  });

  it("drops unknown fields and reports them rather than ignoring them silently", () => {
    const { accepted, rejected } = buildFilters("actions", { nope: 1, priority: "P1" });
    expect(accepted).toEqual({ priority: "P1" });
    expect(rejected).toEqual(["nope"]);
  });

  it("accepts nothing for an unknown table", () => {
    expect(buildFilters("not_a_table", { status: "open" }).accepted).toEqual({});
  });

  it("tolerates a non-object filters argument", () => {
    for (const bad of [null, undefined, "status=open", 5, ["status"]]) {
      expect(buildFilters("actions", bad).accepted).toEqual({});
    }
  });
});

describe("proposal surface: what the AI can put in front of a human", () => {
  it("every domain table the migration populates is proposable", () => {
    // Parity target: whatever a Claude session over Airtable could change, the
    // assistant can propose changing. The exclusions below are audit, config,
    // control-plane and engine-output stores — not client domain data.
    const NOT_DOMAIN_DATA = new Set([
      "activity", // append-only execution log
      "pending_writes", // the approval queue itself
      "chat_sessions",
      "chat_messages", // the assistant's own transcript
      "settings",
      "reference",
      "engagement_types",
      "team", // configuration / control plane
      "hypotheses",
      "corrections",
      "intelligence_snapshot", // learning-loop internals
      "assessments", // written by the assessment engine
      "change_log", // legacy mirror of `variations`, which IS proposable
    ]);
    const gaps = TABLE_KEYS.filter((k) => !NOT_DOMAIN_DATA.has(k) && !WRITER_TABLE[k]);
    expect(gaps, `readable domain tables with no proposal path: ${gaps.join(", ")}`).toEqual([]);
  });

  it("exposes every settable field, not a hand-picked subset", () => {
    // The old create_action advertised 5 fields; the schema has far more, and
    // the ones it omitted were exactly the ones users asked about.
    const create = writableFields("action", "create");
    for (const f of ["title", "detail", "priority", "status", "issueType", "owner", "dueDate", "phaseId"]) {
      expect(create, `action.${f}`).toContain(f);
    }
    expect(create.length).toBeGreaterThan(8);
    // Update schemas are partial: same fields, none of them required.
    expect(writableFields("action", "update").sort()).toEqual(create.sort());
    expect(requiredCreateFields("action")).toContain("title");
  });

  it("reports required create fields so a proposal fails fast, not at the queue", () => {
    expect(requiredCreateFields("cashflow").length).toBeGreaterThan(0);
    expect(requiredCreateFields("action")).not.toContain("detail"); // has a default
  });
});

describe("proposal role gates", () => {
  it("owner may propose anything, including deletion", () => {
    for (const table of Object.values(WRITER_TABLE)) {
      expect(roleCanProposeOn("owner", table!, "create"), table).toBe(true);
      expect(roleCanProposeOn("owner", table!, "delete"), table).toBe(true);
    }
  });

  it("deletion is owner-only for every other role", () => {
    for (const role of ["builder", "architect", "broker"]) {
      for (const table of Object.values(WRITER_TABLE)) {
        expect(roleCanProposeOn(role, table!, "delete"), `${role} → ${table}`).toBe(false);
      }
    }
  });

  it("keeps the Spec 12 scopes the fixed-purpose tools had", () => {
    // Builder: plan + issues, no money, no risks, no rules.
    expect(roleCanProposeOn("builder", "action", "update")).toBe(true);
    expect(roleCanProposeOn("builder", "plan", "update")).toBe(true);
    expect(roleCanProposeOn("builder", "budget_line", "update")).toBe(false);
    expect(roleCanProposeOn("builder", "risk", "create")).toBe(false);
    expect(roleCanProposeOn("builder", "learning_rule", "create")).toBe(false);
    expect(roleCanProposeOn("builder", "variation_order", "create")).toBe(false);
    // Architect adds scope changes and design detail, still no money.
    expect(roleCanProposeOn("architect", "variation_order", "create")).toBe(true);
    expect(roleCanProposeOn("architect", "room", "update")).toBe(true);
    expect(roleCanProposeOn("architect", "cashflow", "create")).toBe(false);
    // Broker raises issues and nothing else.
    expect(roleCanProposeOn("broker", "action", "create")).toBe(true);
    expect(roleCanProposeOn("broker", "action", "update")).toBe(false);
    expect(roleCanProposeOn("broker", "decision", "create")).toBe(false);
  });

  it("a finance sub-role unlocks the money tables its base role is denied", () => {
    // Sub-roles are "+"-composed (roles.ts parseRole): "builder+finance".
    expect(roleCanProposeOn("builder", "cashflow", "update")).toBe(false);
    expect(roleCanProposeOn("builder+finance", "cashflow", "update")).toBe(true);
    expect(roleCanProposeOn("builder+auditor", "budget_line", "update")).toBe(true);
    // …but a finance sub-role is not a licence to delete.
    expect(roleCanProposeOn("builder+finance", "cashflow", "delete")).toBe(false);
  });
});

describe("role gates cover the widened surface", () => {
  it("keeps financial tables owner-only (or finance sub-role) for every base role", () => {
    for (const role of ["builder", "architect", "broker"]) {
      for (const table of ["budget_lines", "cashflows", "quotes", "quote_lines"]) {
        expect(roleCanQueryTable(role, table), `${role} → ${table}`).toBe(false);
      }
    }
    for (const table of ["budget_lines", "cashflows", "quotes", "quote_lines"]) {
      expect(roleCanQueryTable("owner", table), table).toBe(true);
    }
  });

  it("keeps the learning stores and org settings owner-only", () => {
    for (const role of ["builder", "architect", "broker"]) {
      for (const table of [
        "learning_rules",
        "hypotheses",
        "corrections",
        "intelligence_snapshot",
        "settings",
      ]) {
        expect(roleCanQueryTable(role, table), `${role} → ${table}`).toBe(false);
      }
    }
  });

  it("leaves the operational tables readable by every role", () => {
    for (const role of ["owner", "builder", "architect", "broker"]) {
      for (const table of ["actions", "decisions", "phases", "plan", "contacts", "rooms"]) {
        expect(roleCanQueryTable(role, table), `${role} → ${table}`).toBe(true);
      }
    }
  });
});
