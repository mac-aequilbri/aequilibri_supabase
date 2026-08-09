// MCP tenancy proofs (mcp-assistant-plan §5) — the non-negotiable matrix for
// the W2 read-only endpoint, run end to end against two throwaway orgs like
// isolation.test.ts: key/org binding both directions, the per-org kill
// switch, member deactivation, role-based table denies, RLS job scoping, and
// that an orgId smuggled into tool arguments changes nothing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaUnscoped } from "@/lib/db";
import { hashMcpKey, resolveMcpSession, type McpSession } from "./session";
import { handleMcpMessage } from "./server";

const SLUG_A = "test-mcp-a";
const SLUG_B = "test-mcp-b";
const KEY_A_OWNER = "test_mcp_key_a_owner";
const KEY_A_BROKER = "test_mcp_key_a_broker";
const KEY_A_BUILDER = "test_mcp_key_a_builder";
const KEY_B_OWNER = "test_mcp_key_b_owner";

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

beforeAll(async () => {
  await cleanup();
  const a = await prisma.platOrganisation.create({
    data: {
      slug: SLUG_A,
      name: "MCP Org A",
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
  if (ids.length) await prismaUnscoped.platJob.deleteMany({ where: { orgId: { in: ids } } });
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

  it("lists exactly the read-only tool surface", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const res = await handleMcpMessage(session, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = (res.body as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["query_records", "suggest_ingestion_routes"]);
  });

  it("write tools are not callable — not merely hidden", async () => {
    const session = await sessionFor(SLUG_A, KEY_A_OWNER);
    const res = await call(session, "create_action", { title: "smuggled write" });
    expect(res.error?.code).toBe(-32602);
    const count = await prisma.platActionHub.count({ where: { orgId: orgAId } });
    expect(count).toBe(0);
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
