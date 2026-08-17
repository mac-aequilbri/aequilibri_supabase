// MCP tenancy proofs (mcp-assistant-plan §5) — the non-negotiable matrix for
// the W2 read-only endpoint, run end to end against two throwaway orgs like
// isolation.test.ts: key/org binding both directions, the per-org kill
// switch, member deactivation, role-based table denies, RLS job scoping, and
// that an orgId smuggled into tool arguments changes nothing.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, prismaUnscoped } from "@/lib/db";
import { removeOrgMcpKeys } from "@/lib/platform/controlPlane";
import { projectIntelligenceAgent } from "@/services/platform/agents/projectIntelligence";
import { executeToolViaMcp } from "./client";
import { checkMcpRateLimit, resetMcpRateLimit } from "./rateLimit";
import { hashMcpKey, resolveMcpSession, type McpSession } from "./session";
import { handleMcpMessage } from "./server";

const SLUG_A = "test-mcp-a";
const SLUG_B = "test-mcp-b";
// Keys carry the real aeq_mcp_ prefix — the session resolver routes on it
// (prefixed → key path, anything else → OAuth path).
const KEY_A_OWNER = "aeq_mcp_test_a_owner";
const KEY_A_BROKER = "aeq_mcp_test_a_broker";
const KEY_A_BUILDER = "aeq_mcp_test_a_builder";
const KEY_B_OWNER = "aeq_mcp_test_b_owner";

const bearer = (key: string) => `Bearer ${key}`;

function keyEntry(key: string, memberEmail: string) {
  return { keyHash: hashMcpKey(key), memberEmail, label: "test", createdAt: "2026-08-09" };
}

async function sessionFor(slug: string, key: string): Promise<McpSession> {
  const res = await resolveMcpSession(slug, bearer(key));
  if (!res.ok) throw new Error(`Expected a session for ${slug}: ${res.error}`);
  return res.session;
}

/** Run tools/call and return the text payload + isError flag. */
async function call(session: McpSession, name: string, args: Record<string, unknown>) {
  const res = await handleMcpMessage(session, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = res.body as {
    result?: { content: Array<{ text: string }>; isError: boolean };
    error?: { code: number; message: string };
  };
  return { status: res.status, ...body };
}

let orgAId = 0;
let orgBId = 0;
let jobA1 = 0;
let bActionId = 0;

beforeAll(async () => {
  await cleanup();
  const a = await prisma.platOrganisation.create({
    data: {
      slug: SLUG_A,
      name: "MCP Org A",
      // auto_low_risk so the suite exercises BOTH authority branches: low-risk
      // writes execute immediately here; high-risk always proposes. Org B
      // keeps the approve_required default (everything proposes).
      aiAuthority: "auto_low_risk",
      settings: JSON.stringify({
        mcpKeys: [
          keyEntry(KEY_A_OWNER, "owner@a.test"),
          keyEntry(KEY_A_BROKER, "broker@a.test"),
          keyEntry(KEY_A_BUILDER, "builder@a.test"),
        ],
      }),
    },
  });
  const b = await prisma.platOrganisation.create({
    data: {
      slug: SLUG_B,
      name: "MCP Org B",
      settings: JSON.stringify({ mcpKeys: [keyEntry(KEY_B_OWNER, "owner@b.test")] }),
    },
  });
  orgAId = a.id;
  orgBId = b.id;

  await prisma.platCtlTeamMember.createMany({
    data: [
      { orgSlug: SLUG_A, email: "owner@a.test", name: "Owner A", role: "owner" },
      { orgSlug: SLUG_A, email: "broker@a.test", name: "Broker A", role: "broker" },
      { orgSlug: SLUG_A, email: "builder@a.test", name: "Builder A", role: "builder" },
      { orgSlug: SLUG_B, email: "owner@b.test", name: "Owner B", role: "owner" },
    ],
  });
  await prisma.platCtlConnection.createMany({
    data: [SLUG_A, SLUG_B].map((slug) => ({
      orgSlug: slug,
      channel: "mcp",
      direction: "in",
      connectionKey: `${slug}:mcp:in`,
    })),
  });

  const a1 = await prisma.platJob.create({
    data: { orgId: orgAId, code: "A1", name: "Alpha Build" },
  });
  await prisma.platJob.create({ data: { orgId: orgAId, code: "A2", name: "Aurora Extension" } });
  await prisma.platJob.create({ data: { orgId: orgBId, code: "B1", name: "Bravo Tower" } });
  jobA1 = a1.id;

  // Org B action for the cross-org write-refusal proof.
  const bAction = await prisma.platActionHub.create({
    data: { orgId: orgBId, title: "B's private action" },
  });
  bActionId = bAction.id;

  // RLS: the builder is assigned to job A1 only.
  await prisma.platCtlAssignment.create({
    data: { orgSlug: SLUG_A, email: "builder@a.test", jobRecId: String(jobA1) },
  });
});

afterAll(cleanup);

async function cleanup() {
  const slugs = [SLUG_A, SLUG_B];
  const orgs = await prismaUnscoped.platOrganisation.findMany({ where: { slug: { in: slugs } } });
  const ids = orgs.map((o) => o.id);
  if (ids.length) {
    // Tenant rows don't cascade from the control-plane org delete — sweep
    // everything the suite (or the writes it exercises) can have created.
    await prismaUnscoped.platPendingWrite.deleteMany({ where: { orgId: { in: ids } } });
    await prismaUnscoped.platExecutionLog.deleteMany({ where: { orgId: { in: ids } } });
    await prismaUnscoped.platActionHub.deleteMany({ where: { orgId: { in: ids } } });
    await prismaUnscoped.platLearningRule.deleteMany({ where: { orgId: { in: ids } } });
    await prismaUnscoped.platJob.deleteMany({ where: { orgId: { in: ids } } });
  }
  await prisma.platCtlAssignment.deleteMany({ where: { orgSlug: { in: slugs } } });
  await prisma.platCtlConnection.deleteMany({ where: { orgSlug: { in: slugs } } });
  await prisma.platCtlTeamMember.deleteMany({ where: { orgSlug: { in: slugs } } });
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: { in: slugs } } });
}

describe("MCP session auth (org/key binding)", () => {
  it("rejects an unknown org", async () => {
    const res = await resolveMcpSession("test-mcp-nope", bearer(KEY_A_OWNER));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(404);
  });

  it("rejects a missing or malformed bearer token", async () => {
    for (const header of [null, "", "Basic abc", "Bearer "]) {
      const res = await resolveMcpSession(SLUG_A, header);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(401);
    }
  });

  it("refuses org A's key on org B's endpoint, and the reverse", async () => {
    const aOnB = await resolveMcpSession(SLUG_B, bearer(KEY_A_OWNER));
    const bOnA = await resolveMcpSession(SLUG_A, bearer(KEY_B_OWNER));
    for (const res of [aOnB, bOnA]) {
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.status).toBe(401);
    }
  });

  it("resolves a valid key to the bound member's identity", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    expect(session.ctx.orgSlug).toBe(SLUG_A);
    expect(session.user.email).toBe("owner@a.test");
    expect(session.user.role).toBe("owner");
  });

  it("the mcp:in connection row is a working kill switch", async () => {
    await prisma.platCtlConnection.updateMany({
      where: { orgSlug: SLUG_A, channel: "mcp" },
      data: { isActive: false },
    });
    const res = await resolveMcpSession(SLUG_A, bearer(KEY_A_OWNER));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
    await prisma.platCtlConnection.updateMany({
      where: { orgSlug: SLUG_A, channel: "mcp" },
      data: { isActive: true },
    });
  });

  it("a deactivated member's key stops working", async () => {
    await prisma.platCtlTeamMember.updateMany({
      where: { orgSlug: SLUG_A, email: "broker@a.test" },
      data: { isActive: false },
    });
    const res = await resolveMcpSession(SLUG_A, bearer(KEY_A_BROKER));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
    await prisma.platCtlTeamMember.updateMany({
      where: { orgSlug: SLUG_A, email: "broker@a.test" },
      data: { isActive: true },
    });
  });
});

describe("MCP protocol surface", () => {
  it("initialize negotiates a supported protocol version", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const known = await handleMcpMessage(session, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect((known.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-03-26");
    const unknown = await handleMcpMessage(session, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect((unknown.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
  });

  it("lists the full surface for an owner, never onboarding_status", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const res = await handleMcpMessage(session, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (res.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (t) => t.name,
    );
    for (const expected of ["query_records", "create_action", "update_budget_line", "draft_comm"]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain("onboarding_status");
  });

  it("tools outside the session's reach are not callable — not merely hidden", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    // Not on the surface at all.
    expect((await call(session, "drop_all_tables", {})).error?.code).toBe(-32602);
    // On the surface but operator-gated: API-key sessions are never admins.
    expect((await call(session, "onboarding_status", {})).error?.code).toBe(-32602);
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const res = await handleMcpMessage(session, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });

  it("rejects batch messages", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const res = await handleMcpMessage(session, [{ jsonrpc: "2.0", id: 1, method: "ping" }]);
    expect(res.status).toBe(400);
  });
});

describe("tenancy through tools/call", () => {
  it("an owner session reads its own org's jobs and nothing of the other org", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const res = await call(session, "query_records", { table: "jobs" });
    expect(res.result?.isError).toBe(false);
    const text = res.result!.content[0].text;
    expect(text).toContain("Alpha Build");
    expect(text).toContain("Aurora Extension");
    expect(text).not.toContain("Bravo Tower");
  });

  it("the other org's session sees the mirror image", async () => {
    const session = await sessionFor(SLUG_B, KEY_B_OWNER);
    const text = (await call(session, "query_records", { table: "jobs" })).result!.content[0].text;
    expect(text).toContain("Bravo Tower");
    expect(text).not.toContain("Alpha Build");
  });

  it("an orgId smuggled into the arguments changes nothing", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const text = (
      await call(session, "query_records", { table: "jobs", orgId: orgBId, orgSlug: SLUG_B })
    ).result!.content[0].text;
    expect(text).toContain("Alpha Build");
    expect(text).not.toContain("Bravo Tower");
  });

  it("role read-denies hold: a broker cannot read financial tables", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_BROKER);
    const res = await call(session, "query_records", { table: "budget_lines" });
    expect(res.result?.isError).toBe(true);
    expect(res.result!.content[0].text).toMatch(/does not have access/i);
  });

  it("RLS holds: a builder assigned to one job sees only that job", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_BUILDER);
    const text = (await call(session, "query_records", { table: "jobs" })).result!.content[0].text;
    expect(text).toContain("Alpha Build");
    expect(text).not.toContain("Aurora Extension");
  });
});

describe("W3: writes through the approval gate", () => {
  it("scopes the tool listing to the session member's role", async () => {
    const broker = await sessionFor(SLUG_A, KEY_A_BROKER);
    const res = await handleMcpMessage(broker, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names = (res.body as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (t) => t.name,
    );
    expect(names).toContain("query_records");
    expect(names).toContain("create_action"); // broker may flag a decision needed
    expect(names).not.toContain("update_budget_line");
    expect(names).not.toContain("save_decision");
  });

  it("auto_low_risk: a low-risk write executes, attributed to the MCP actor", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const res = await call(session, "create_action", {
      title: "MCP-created action",
      proposalReason: "approval-gate proof",
    });
    expect(res.result?.isError).toBe(false);
    expect(res.result!.content[0].text).toMatch(/executed/i);

    const row = await prisma.platActionHub.findFirst({
      where: { orgId: orgAId, title: "MCP-created action" },
    });
    expect(row).not.toBeNull();
    const log = await prisma.platExecutionLog.findFirst({
      where: { orgId: orgAId, actorName: "mcp:owner@a.test", status: "executed" },
    });
    expect(log).not.toBeNull();
    expect(log!.actorType).toBe("ai");
  });

  it("a high-risk write ALWAYS lands as a pending proposal, even under auto_low_risk", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const res = await call(session, "propose_rule", {
      description: "Always cross-check CASHFLOWS before vendor writes",
      proposalReason: "approval-gate proof",
    });
    expect(res.result?.isError).toBe(false);
    expect(res.result!.content[0].text).toMatch(/must approve|pending approval/i);

    const pending = await prisma.platPendingWrite.findFirst({
      where: { orgId: orgAId, tableKey: "learning_rule", status: "proposed" },
    });
    expect(pending).not.toBeNull();
    expect(pending!.actorName).toBe("mcp:owner@a.test");
    expect(pending!.actorType).toBe("ai");
    const rule = await prisma.platLearningRule.findFirst({
      where: { orgId: orgAId, description: { contains: "cross-check CASHFLOWS" } },
    });
    expect(rule).toBeNull(); // proposed, not written
  });

  it("approve_required (org B default): even a low-risk write only proposes", async () => {
    const session = await sessionFor(SLUG_B, KEY_B_OWNER);
    const res = await call(session, "create_action", { title: "B action via MCP" });
    expect(res.result?.isError).toBe(false);
    expect(res.result!.content[0].text).toMatch(/must approve|pending approval/i);
    const pending = await prisma.platPendingWrite.findFirst({
      where: { orgId: orgBId, tableKey: "action", status: "proposed" },
    });
    expect(pending).not.toBeNull();
    const row = await prisma.platActionHub.findFirst({
      where: { orgId: orgBId, title: "B action via MCP" },
    });
    expect(row).toBeNull(); // proposed, not written
  });

  it("role write gates hold: a broker cannot save a decision", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_BROKER);
    const res = await call(session, "save_decision", { description: "broker overreach" });
    expect(res.result?.isError).toBe(true);
    // The refusal names the tool rather than declaring the role read-only: a
    // broker can still raise an action, and "you are read-only" led the model
    // to tell the user nothing at all could be changed.
    expect(res.result!.content[0].text).toMatch(/may not use "save_decision"/i);
  });

  it("cross-org writes are refused: org A cannot update org B's action", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const res = await call(session, "update_action", { recordId: bActionId, status: "done" });
    expect(res.result?.isError).toBe(true);
    expect(res.result!.content[0].text).toMatch(/not found in this organisation/i);
    const untouched = await prisma.platActionHub.findFirst({
      where: { id: bActionId, orgId: orgBId },
    });
    expect(untouched!.status).not.toBe("done");
  });
});

describe("W5: the in-app assistant's in-process MCP client", () => {
  /** An in-app-style session, as the agent loop builds it: the chat viewer's
   *  identity, the agent's tool bundle, and the chat actor for provenance. */
  async function inAppSession(overrides: Partial<McpSession> = {}): Promise<McpSession> {
    const base = await sessionFor(SLUG_A, KEY_A_OWNER);
    return {
      ctx: base.ctx,
      user: { name: "Owner A", email: "owner@a.test", role: "owner" },
      platformAdmin: false,
      tools: Object.keys(projectIntelligenceAgent.toolPolicy),
      actor: { type: "ai", name: "Test Assistant", sourceMessageId: 42 },
      ...overrides,
    };
  }

  it("outcome parity: structured fields and chat write provenance survive the protocol", async () => {
    const session = await inAppSession();
    const outcome = await executeToolViaMcp(session, {
      name: "create_action",
      input: { title: "W5 parity action" },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("executed"); // structuredContent round-trip
    expect(outcome.recordId).toBeDefined();

    const row = await prisma.platActionHub.findFirst({
      where: { orgId: orgAId, title: "W5 parity action" },
    });
    // Chat provenance is untouched by the MCP routing: sourceId is the chat
    // message id from the actor, and the audit log carries the chat actor's
    // name, not the external mcp:<email> form.
    expect(row!.sourceId).toBe(42);
    const log = await prisma.platExecutionLog.findFirst({
      where: { orgId: orgAId, actorName: "Test Assistant", status: "executed" },
    });
    expect(log).not.toBeNull();
  });

  it("proposals surface their proposalId (the approval cards' input)", async () => {
    const session = await inAppSession({
      tools: ["propose_rule"], // learning-loop agent's territory
    });
    const outcome = await executeToolViaMcp(session, {
      name: "propose_rule",
      input: { description: "W5 parity rule" },
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe("proposed");
    expect(outcome.proposalId).toBeDefined();
  });

  it("the session's tool subset pins the agent bundle: outside tools are unknown", async () => {
    const session = await inAppSession(); // project_intelligence bundle
    const outcome = await executeToolViaMcp(session, {
      name: "propose_rule", // learning-loop tool, not in this bundle
      input: { description: "should not exist" },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.summary).toMatch(/unknown tool/i);
  });

  it("onboarding_status works for a platform-admin session and only then", async () => {
    const admin = await inAppSession({ platformAdmin: true, tools: ["onboarding_status"] });
    const ok = await executeToolViaMcp(admin, { name: "onboarding_status", input: {} });
    expect(ok.ok).toBe(true);
    expect(ok.summary).toMatch(/readiness/i);

    const notAdmin = await inAppSession({ platformAdmin: false, tools: ["onboarding_status"] });
    const denied = await executeToolViaMcp(notAdmin, { name: "onboarding_status", input: {} });
    expect(denied.ok).toBe(false);
  });
});

describe("W4: OAuth access tokens for human MCP consumers", () => {
  const ISSUER = "https://auth.test";
  const TOKENS: Record<string, string> = {
    "oauth-token-owner-a": "owner@a.test",
    "oauth-token-stranger": "stranger@nowhere.test",
  };
  let savedIssuer: string | undefined;
  let savedAdmins: string | undefined;

  beforeAll(() => {
    savedIssuer = process.env.MCP_OAUTH_ISSUER;
    savedAdmins = process.env.PLATFORM_ADMIN_EMAILS;
    process.env.MCP_OAUTH_ISSUER = ISSUER;
    // The AS's userinfo endpoint, mocked: token → email claim.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
        if (String(url) !== `${ISSUER}/oauth/userinfo`) {
          return new Response("not found", { status: 404 });
        }
        const token = /^Bearer\s+(.+)$/.exec(init?.headers?.Authorization ?? "")?.[1] ?? "";
        const email = TOKENS[token];
        return email
          ? new Response(JSON.stringify({ sub: "u_1", email }), { status: 200 })
          : new Response("", { status: 401 });
      }),
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    if (savedIssuer === undefined) delete process.env.MCP_OAUTH_ISSUER;
    else process.env.MCP_OAUTH_ISSUER = savedIssuer;
    if (savedAdmins === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = savedAdmins;
  });

  it("a valid token resolves to the member's identity — not an operator by default", async () => {
    delete process.env.PLATFORM_ADMIN_EMAILS;
    const res = await resolveMcpSession(SLUG_A, bearer("oauth-token-owner-a"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.session.user.email).toBe("owner@a.test");
      expect(res.session.user.role).toBe("owner");
      expect(res.session.platformAdmin).toBe(false);
    }
  });

  it("membership is the wall: a valid token for a non-member is refused", async () => {
    const res = await resolveMcpSession(SLUG_A, bearer("oauth-token-stranger"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it("cross-org: org A's member token is refused on org B", async () => {
    const res = await resolveMcpSession(SLUG_B, bearer("oauth-token-owner-a"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it("an invalid or expired token is a 401", async () => {
    const res = await resolveMcpSession(SLUG_A, bearer("oauth-token-revoked"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.error).toMatch(/access token/i);
    }
  });

  it("PLATFORM_ADMIN_EMAILS grants the operator flag to a member's token", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "owner@a.test";
    const res = await resolveMcpSession(SLUG_A, bearer("oauth-token-owner-a"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.session.platformAdmin).toBe(true);
    delete process.env.PLATFORM_ADMIN_EMAILS;
  });

  it("with OAuth unconfigured, non-key tokens are refused without calling out", async () => {
    delete process.env.MCP_OAUTH_ISSUER;
    const res = await resolveMcpSession(SLUG_A, bearer("oauth-token-owner-a"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
    process.env.MCP_OAUTH_ISSUER = ISSUER;
  });

  it("the RFC 9728 metadata document names the issuer and echoes the resource", async () => {
    const { GET } = await import(
      "@/app/.well-known/oauth-protected-resource/[[...resource]]/route"
    );
    const { NextRequest } = await import("next/server");
    const req = new NextRequest(
      "https://app.example/.well-known/oauth-protected-resource/api/mcp/test-mcp-a",
    );
    const res = await GET(req, { params: Promise.resolve({ resource: ["api", "mcp", "test-mcp-a"] }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe("https://app.example/api/mcp/test-mcp-a");
    expect(body.authorization_servers).toEqual([ISSUER]);
  });
});

describe("W6: rate limits and key revocation", () => {
  let savedLimit: string | undefined;
  beforeAll(() => {
    savedLimit = process.env.MCP_RATE_LIMIT_PER_MIN;
  });
  afterAll(() => {
    if (savedLimit === undefined) delete process.env.MCP_RATE_LIMIT_PER_MIN;
    else process.env.MCP_RATE_LIMIT_PER_MIN = savedLimit;
    resetMcpRateLimit();
  });

  it("allows up to the per-org limit, then blocks with a retry hint", () => {
    process.env.MCP_RATE_LIMIT_PER_MIN = "3";
    resetMcpRateLimit();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect(checkMcpRateLimit("org-x", t0 + i).allowed).toBe(true);
    const blocked = checkMcpRateLimit("org-x", t0 + 3);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("orgs are limited independently and windows reset", () => {
    process.env.MCP_RATE_LIMIT_PER_MIN = "1";
    resetMcpRateLimit();
    const t0 = 2_000_000;
    expect(checkMcpRateLimit("org-a", t0).allowed).toBe(true);
    expect(checkMcpRateLimit("org-a", t0 + 1).allowed).toBe(false);
    expect(checkMcpRateLimit("org-b", t0 + 2).allowed).toBe(true); // other org unaffected
    expect(checkMcpRateLimit("org-a", t0 + 61_000).allowed).toBe(true); // new window
  });

  it("the endpoint sheds over-limit traffic before auth, with Retry-After", async () => {
    process.env.MCP_RATE_LIMIT_PER_MIN = "2";
    resetMcpRateLimit();
    const { POST } = await import("@/app/api/mcp/[org]/route");
    const { NextRequest } = await import("next/server");
    const hit = () =>
      POST(
        new NextRequest("https://app.example/api/mcp/rate-test-org", {
          method: "POST",
          body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
        }),
        { params: Promise.resolve({ org: "rate-test-org" }) },
      );
    expect((await hit()).status).toBe(404); // unknown org, but under the limit
    expect((await hit()).status).toBe(404);
    const third = await hit();
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    resetMcpRateLimit();
  });

  it("revoking a member's keys cuts access on the next request, others unaffected", async () => {
    delete process.env.MCP_RATE_LIMIT_PER_MIN;
    resetMcpRateLimit();
    expect((await resolveMcpSession(SLUG_A, bearer(KEY_A_BROKER))).ok).toBe(true);

    const removed = await removeOrgMcpKeys(SLUG_A, { memberEmail: "broker@a.test" });
    expect(removed).toBe(1);

    const revoked = await resolveMcpSession(SLUG_A, bearer(KEY_A_BROKER));
    expect(revoked.ok).toBe(false);
    if (!revoked.ok) expect(revoked.status).toBe(401);
    expect((await resolveMcpSession(SLUG_A, bearer(KEY_A_OWNER))).ok).toBe(true);
  });
});
