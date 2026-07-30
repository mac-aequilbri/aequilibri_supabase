import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgCtx } from "@/lib/platform/types";

const h = vi.hoisted(() => ({ callClaude: vi.fn() }));

vi.mock("@/lib/claude", () => ({ callClaude: h.callClaude }));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() }, errMeta: () => ({}) }));

const { extractEmailIntents } = await import("./emailIntel");

const ctx = { orgId: 1, orgSlug: "sunridge", config: {} } as unknown as OrgCtx;

/** The model replied with this JSON (as it would, fenced or not). */
function replies(json: unknown, fenced = false) {
  const body = JSON.stringify(json);
  h.callClaude.mockResolvedValue({
    content: fenced ? "```json\n" + body + "\n```" : body,
    tool_uses: [],
    demo_mode: false,
  });
}

const input = {
  subject: "Plasterboard order",
  body: "Please order 40 sheets of plasterboard by Friday. Ross will sign off.",
  sender: "mac@aequilibri.com",
  jobId: "recJob1",
  jobName: "Maleny Ridge House",
  docDate: "2026-07-29",
};

beforeEach(() => h.callClaude.mockReset());

describe("extractEmailIntents — happy path", () => {
  it("maps an action intent onto the action writer's field names", async () => {
    replies({
      intents: [
        {
          table: "action",
          summary: "Order plasterboard",
          evidence: "Please order 40 sheets of plasterboard by Friday.",
          confidence: 0.9,
          fields: { title: "Order 40 sheets of plasterboard", owner: "Ross", dueDate: "2026-07-31", priority: "P1" },
        },
      ],
    });
    const [s] = await extractEmailIntents(ctx, input);
    expect(s.table).toBe("action");
    expect(s.payload).toMatchObject({
      jobId: "recJob1",
      title: "Order 40 sheets of plasterboard",
      owner: "Ross",
      dueDate: "2026-07-31",
      priority: "P1",
      status: "open",
    });
    expect(s.evidence).toContain("40 sheets");
    expect(s.confidence).toBe(0.9);
  });

  it("parses a fenced JSON reply", async () => {
    replies({ intents: [{ table: "risk", confidence: 0.8, fields: { description: "Wet weather may delay the slab" } }] }, true);
    const out = await extractEmailIntents(ctx, input);
    expect(out).toHaveLength(1);
    expect(out[0].payload).toMatchObject({ description: "Wet weather may delay the slab", createdByAi: true });
  });

  it("derives procurement total from qty x unitPrice", async () => {
    replies({
      intents: [{ table: "procurement", confidence: 0.9, fields: { item: "Plasterboard", qty: 40, unitPrice: "$22.50" } }],
    });
    const [s] = await extractEmailIntents(ctx, input);
    expect(s.payload).toMatchObject({ qty: 40, unitPrice: 22.5, total: 900 });
  });
});

describe("extractEmailIntents — refusing bad output", () => {
  it("drops intents below the confidence floor", async () => {
    replies({ intents: [{ table: "action", confidence: 0.2, fields: { title: "Maybe do something" } }] });
    expect(await extractEmailIntents(ctx, input)).toEqual([]);
  });

  it("drops an unknown table", async () => {
    replies({ intents: [{ table: "invoice", confidence: 0.9, fields: { title: "x" } }] });
    expect(await extractEmailIntents(ctx, input)).toEqual([]);
  });

  it("drops an intent missing its required field", async () => {
    replies({ intents: [{ table: "action", confidence: 0.9, fields: { owner: "Ross" } }] });
    expect(await extractEmailIntents(ctx, input)).toEqual([]);
  });

  it("drops a cashflow line with no amount", async () => {
    replies({ intents: [{ table: "cashflow", confidence: 0.9, fields: { name: "Invoice", period: "2026-07" } }] });
    expect(await extractEmailIntents(ctx, input)).toEqual([]);
  });

  it("survives malformed JSON", async () => {
    h.callClaude.mockResolvedValue({ content: "sorry, I can't do that", tool_uses: [], demo_mode: false });
    expect(await extractEmailIntents(ctx, input)).toEqual([]);
  });

  it("survives intents that is not an array", async () => {
    replies({ intents: "lots" });
    expect(await extractEmailIntents(ctx, input)).toEqual([]);
  });

  it("discards an invalid date rather than passing it to the writer", async () => {
    replies({ intents: [{ table: "action", confidence: 0.9, fields: { title: "Do it", dueDate: "next Friday" } }] });
    const [s] = await extractEmailIntents(ctx, input);
    expect(s.payload).not.toHaveProperty("dueDate");
  });

  it("clamps an out-of-range risk score instead of rejecting the intent", async () => {
    replies({ intents: [{ table: "risk", confidence: 0.9, fields: { description: "Delay", likelihood: 99, impact: -4 } }] });
    const [s] = await extractEmailIntents(ctx, input);
    expect(s.payload).toMatchObject({ likelihood: 5, impact: 1 });
  });
});

describe("extractEmailIntents — money guards", () => {
  it("never marks money as paid off an email (status forced to Forecast)", async () => {
    replies({
      intents: [{ table: "cashflow", confidence: 0.95, fields: { name: "Invoice 12", amount: 4200, status: "Paid" } }],
    });
    const [s] = await extractEmailIntents(ctx, input);
    expect(s.payload).toMatchObject({ amount: 4200, status: "Forecast" });
  });

  it("drops a cashflow intent with no positive amount", async () => {
    replies({ intents: [{ table: "cashflow", confidence: 0.95, fields: { name: "Invoice 12" } }] });
    expect(await extractEmailIntents(ctx, input)).toEqual([]);
  });
});

describe("extractEmailIntents — degradation", () => {
  it("falls back to the regex rules when the AI is unavailable", async () => {
    h.callClaude.mockResolvedValue({ content: "**[Demo Mode]** …", tool_uses: [], demo_mode: true });
    // "due" is one of the four keywords the regex engine knows; the point is
    // that with a job id now resolved, that rule can finally fire at all.
    const out = await extractEmailIntents(ctx, {
      ...input,
      body: "The plasterboard order is due Friday.",
    });
    expect(out.map((s) => s.table)).toContain("action");
    expect(out[0].payload).toMatchObject({ jobId: "recJob1" });
  });

  it("returns nothing for an empty message without calling the model", async () => {
    expect(await extractEmailIntents(ctx, { ...input, subject: "", body: "" })).toEqual([]);
    expect(h.callClaude).not.toHaveBeenCalled();
  });
});
