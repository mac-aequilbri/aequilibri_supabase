// Orchestrator routing — the short-circuit (one specialist → run it directly,
// no extra model call) is the invariant that keeps single-agent behaviour
// unchanged. Forced into demo mode so it runs offline and deterministically.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor, OrgCtx } from "@/lib/platform/types";
import { buildDelegateTool, runOrchestrator, type Specialist } from "./orchestrator";
import { MAX_AGENT_DELEGATION_DEPTH, delegationTargets } from "./loop";
import { projectIntelligenceAgent } from "./projectIntelligence";
import { SPECIALISTS } from "./registry";
import type { DelegationContext } from "./types";

const ctx = { orgName: "Test Org", orgSlug: "test", orgId: 1 } as unknown as OrgCtx;
const actor: Actor = { type: "ai", name: "Assistant" };

let savedKey: string | undefined;
beforeAll(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = ""; // force demo mode — no network
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

describe("orchestrator routing", () => {
  it("short-circuits to the single specialist without delegating", async () => {
    const specialists: Specialist[] = [{ agent: projectIntelligenceAgent, system: "sys" }];
    const r = await runOrchestrator(ctx, [{ role: "user", content: "what's the budget?" }], actor, {
      specialists,
      orgName: "Test Org",
    });
    expect(r.delegations).toEqual([]); // no routing choice → no delegation trace
    expect(r.demoMode).toBe(true);
    expect(r.reply.length).toBeGreaterThan(0);
  });

  it("returns a graceful message when no specialists are registered", async () => {
    const r = await runOrchestrator(ctx, [{ role: "user", content: "hi" }], actor, {
      specialists: [],
      orgName: "Test Org",
    });
    expect(r.reply).toMatch(/no assistant/i);
    expect(r.demoMode).toBe(false);
  });
});

describe("specialist registry + delegate tool", () => {
  it("registers all seven module-agents", () => {
    const keys = SPECIALISTS.map((a) => a.key).sort();
    expect(keys).toEqual(
      [
        "assessment",
        "document",
        "ingestion",
        "learning_loop",
        "onboarding",
        "project_intelligence",
        "reporting",
      ].sort(),
    );
  });

  it("delegate tool enum lists exactly the available specialists", () => {
    const specialists: Specialist[] = SPECIALISTS.map((agent) => ({ agent, system: "sys" }));
    const tool = buildDelegateTool(specialists);
    const props = tool.input_schema.properties as { agent: { enum: string[] } };
    expect(props.agent.enum).toEqual(SPECIALISTS.map((a) => a.key));
  });

  it("partitions write tools across agents with no overlap (read tools shared)", () => {
    // Every specialist gets the whole read surface — discovery, query, single
    // record. Only write tools are partitioned.
    const shared = new Set(["query_records", "describe_data", "get_record"]);
    const writeOwners = new Map<string, string[]>();
    for (const agent of SPECIALISTS) {
      for (const name of Object.keys(agent.toolPolicy)) {
        if (shared.has(name)) continue;
        writeOwners.set(name, [...(writeOwners.get(name) ?? []), agent.key]);
      }
    }
    for (const [tool, owners] of writeOwners) {
      expect(owners, `${tool} owned by ${owners.join(", ")}`).toHaveLength(1);
    }
  });
});

describe("inter-agent delegation depth guard", () => {
  const specialists: Specialist[] = SPECIALISTS.map((agent) => ({ agent, system: "sys" }));
  const byKey = new Map<string, Specialist>(specialists.map((s) => [s.agent.key, s]));
  const at = (depth: number): DelegationContext => ({
    specialists,
    byKey,
    depth,
    maxDepth: MAX_AGENT_DELEGATION_DEPTH,
  });

  it("offers delegation targets below the depth cap, excluding self", () => {
    const targets = delegationTargets("assessment", at(1));
    expect(targets.length).toBe(specialists.length - 1);
    expect(targets.map((t) => t.agent.key)).not.toContain("assessment");
  });

  it("offers no targets once the depth cap is reached", () => {
    expect(delegationTargets("assessment", at(MAX_AGENT_DELEGATION_DEPTH))).toEqual([]);
  });

  it("offers no targets when there is no delegation context", () => {
    expect(delegationTargets("assessment", undefined)).toEqual([]);
  });
});
