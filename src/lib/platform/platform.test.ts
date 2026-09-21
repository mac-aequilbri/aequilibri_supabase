import { describe, expect, it } from "vitest";
import { calcConfidence, combine, confidenceBand } from "./confidence";
import { diffForCorrections } from "./corrections";
import { diffStoredVsSubmitted, valuesEquivalent } from "./reconciliation";
import { getPrompt } from "./prompts";
import { modelFor } from "./modelRouter";
import { procurementLateness } from "./procurementSource";
import { validateRecord } from "./recordWriter";

describe("recordWriter validateRecord (typecast layer)", () => {
  it("coerces form-style strings on create", () => {
    const out = validateRecord("budget_line", "create", {
      jobId: "7",
      category: "Concrete",
      budgetAmount: "120000",
      actualAmount: "131500.50",
    });
    expect(out.jobId).toBe(7);
    expect(out.budgetAmount).toBe(120000);
    expect(out.actualAmount).toBe(131500.5);
    expect(out.committedAmount).toBe(0); // default applied
  });

  it("coerces checkbox booleans and empty dates", () => {
    const out = validateRecord("risk", "create", {
      jobId: 3,
      description: "Supplier capacity",
      createdByAi: "on",
      escalatedAt: "",
    });
    expect(out.createdByAi).toBe(true);
    expect(out.escalatedAt).toBeUndefined();
    expect(out.likelihood).toBe(3);
  });

  it("rejects missing required fields", () => {
    expect(() => validateRecord("action", "create", { title: "" })).toThrow();
    expect(() => validateRecord("cashflow", "create", { jobId: 1, period: "June" })).toThrow();
  });

  it("rejects invalid JSON in json-string columns", () => {
    expect(() =>
      validateRecord("action", "create", { title: "x", context: "{not json" }),
    ).toThrow();
  });

  it("update schemas are partial", () => {
    const out = validateRecord("action", "update", { status: "done" });
    expect(out).toEqual({ status: "done" });
  });

  it("parses ISO date strings revived from stored proposals", () => {
    const out = validateRecord("action", "update", { dueDate: "2026-06-15T00:00:00.000Z" });
    expect(out.dueDate).toBeInstanceOf(Date);
  });

  it("accepts a phase RAG update (Spec 12 Module 5)", () => {
    const out = validateRecord("phase", "update", { rag: "Amber" });
    expect(out).toEqual({ rag: "Amber" });
  });
});

describe("procurementLateness (Spec 12 procurement tracker)", () => {
  const now = new Date("2026-07-13T00:00:00.000Z");

  it("reports a late delivery when actual is after expected", () => {
    const r = procurementLateness("2026-07-01", "2026-07-08", "delivered", now);
    expect(r).toEqual({ deltaDays: 7, isLate: true });
  });

  it("reports early/on-time delivery as not late", () => {
    expect(procurementLateness("2026-07-10", "2026-07-08", "invoiced", now).isLate).toBe(false);
    expect(procurementLateness("2026-07-08", "2026-07-08", "paid", now).deltaDays).toBe(0);
  });

  it("flags an open order past its expected date as overdue", () => {
    const r = procurementLateness("2026-07-01", null, "ordered", now);
    expect(r).toEqual({ deltaDays: 12, isLate: true });
  });

  it("does not flag a delivered order with no actual date", () => {
    expect(procurementLateness("2026-07-01", null, "delivered", now)).toEqual({
      deltaDays: null,
      isLate: false,
    });
  });

  it("returns null delta when the expected date is unknown", () => {
    expect(procurementLateness(null, null, "ordered", now)).toEqual({
      deltaDays: null,
      isLate: false,
    });
  });
});

describe("confidence calculator", () => {
  it("weights signals", () => {
    expect(
      calcConfidence([
        { source: "a", weight: 1, score: 100 },
        { source: "b", weight: 1, score: 50 },
      ]),
    ).toBe(75);
  });
  it("returns 0 with no usable weight", () => {
    expect(calcConfidence([])).toBe(0);
  });
  it("combines multiplicatively and bands", () => {
    expect(combine(90, 80)).toBe(72);
    expect(confidenceBand(85)).toBe("high");
    expect(confidenceBand(60)).toBe("medium");
    expect(confidenceBand(10)).toBe("low");
  });
});

describe("diffForCorrections", () => {
  const base = {
    entityType: "variation_order",
    jobId: 1,
    rootCause: "edited on approval",
    rootCauseCategory: "Estimation Error" as const,
    sourceModule: "module3" as const,
  };
  it("emits one correction per changed numeric dimension", () => {
    const out = diffForCorrections(
      { costImpact: 18400, timeImpactDays: 6 },
      { costImpact: 22000, timeImpactDays: 6 },
      [
        { field: "costImpact", dimension: "variation.cost_impact" },
        { field: "timeImpactDays", dimension: "variation.time_impact" },
      ],
      base,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      dimension: "variation.cost_impact",
      aiValue: 18400,
      humanValue: 22000,
    });
  });
  it("ignores non-numeric and unchanged fields", () => {
    const out = diffForCorrections({ a: "x" }, { a: "y" }, [{ field: "a", dimension: "d" }], base);
    expect(out).toHaveLength(0);
  });
});

describe("post-write reconciliation (Spec 12 Module 2)", () => {
  it("tolerates Airtable storage conventions (typecast, absent falsy fields)", () => {
    expect(valuesEquivalent("5", 5)).toBe(true);
    expect(valuesEquivalent(5, "5.0")).toBe(true);
    expect(valuesEquivalent(false, undefined)).toBe(true); // unchecked checkbox omitted on read
    expect(valuesEquivalent("", undefined)).toBe(true);
    expect(valuesEquivalent([], undefined)).toBe(true);
    expect(valuesEquivalent(" trimmed ", "trimmed")).toBe(true);
    expect(valuesEquivalent(["recA", "recB"], ["recB", "recA"])).toBe(true);
  });

  it("flags genuine divergence between submitted and stored values", () => {
    expect(valuesEquivalent(5, 6)).toBe(false);
    expect(valuesEquivalent("Ordered", "Paid")).toBe(false);
    expect(valuesEquivalent("x", undefined)).toBe(false);
    expect(valuesEquivalent(["recA"], ["recA", "recB"])).toBe(false);
  });

  it("diffs only submitted fields, naming submitted and stored values", () => {
    const out = diffStoredVsSubmitted(
      { Status: "Ordered", Quantity: "5", Notes: undefined },
      { Status: "Paid", Quantity: 5, Total_Cost: 999 }, // Total_Cost = formula, never sent
    );
    expect(out).toEqual([{ field: "Status", submitted: "Ordered", stored: "Paid" }]);
  });
});

describe("prompt assembler", () => {
  it("interpolates variables and returns a version stamp", () => {
    const { system, version } = getPrompt("assistant.chat", {
      persona: "You are Didi.",
      orgName: "Dulong Downs",
      jobLine: " on job DD-001",
      today: "2026-08-17",
      tables: "jobs, actions, cashflows",
      rulesBlock: "CRITICAL RULES:\n- rule one",
    });
    expect(system).toContain("You are Didi.");
    expect(system).toContain("Dulong Downs");
    expect(system).toContain("rule one");
    // The assistant must know the date and its own readable surface, or every
    // "overdue" answer is a guess and every unknown table is "not available".
    expect(system).toContain("Today is 2026-08-17");
    expect(system).toContain("cashflows");
    expect(version).toBe("assistant.chat@1.2");
  });
  it("throws on unknown template", () => {
    expect(() => getPrompt("nope")).toThrow();
  });
});

describe("model router", () => {
  it("routes tasks to tiers", () => {
    expect(modelFor("classification")).toContain("haiku");
    expect(modelFor("drafting")).toContain("sonnet");
    // Chat is the assistant's answering tier — it runs on Opus so a client
    // comparing us against their own Claude session is comparing like for like.
    expect(modelFor("chat")).toContain("opus");
    expect(modelFor("complex_reasoning")).toContain("opus");
  });
});
