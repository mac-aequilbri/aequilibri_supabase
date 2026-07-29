// Multi-tenant isolation is the platform's most safety-critical property: one
// org must never read or write another's data. These tests pin that down end to
// end against two throwaway orgs — the org-isolation guard, the write paths,
// readRecord, deferred-proposal execution, and the encrypted token store — plus
// the demo-mode RBAC resolution. Cascade-deleted around the suite.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaUnscoped } from "@/lib/db";
import { executeProposal, readRecord, writeRecord } from "@/lib/platform/recordWriter";
import { loadAccountingToken, saveAccountingToken } from "@/lib/platform/accounting";
import { getCurrentUser, requireAdmin } from "@/lib/platform/org-context";
import { OrgCtx } from "@/lib/platform/types";

const actor = { type: "human" as const, name: "iso-suite" };

function ctxFor(org: { id: number; slug: string; name: string }): OrgCtx {
  return {
    orgId: org.id,
    orgSlug: org.slug,
    orgName: org.name,
    vertical: "construction",
    defaultEngagementType: "long_project",
    allowedEngagementTypes: ["long_project"],
    aiAuthority: "approve_required",
    config: { assistant: { name: "T", persona: "t" }, features: {} },
  };
}

let A: OrgCtx;
let B: OrgCtx;
const SLUGS = ["test-iso-a", "test-iso-b"];

beforeAll(async () => {
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: { in: SLUGS } } });
  const a = await prisma.platOrganisation.create({ data: { slug: SLUGS[0], name: "Iso Org A" } });
  const b = await prisma.platOrganisation.create({ data: { slug: SLUGS[1], name: "Iso Org B" } });
  A = ctxFor(a);
  B = ctxFor(b);
});

afterAll(async () => {
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: { in: SLUGS } } });
  await prisma.platCtlTeamMember.deleteMany({ where: { orgSlug: { in: SLUGS } } });
});

describe("org-isolation guard", () => {
  it("blocks fan-out reads that omit orgId, across models", async () => {
    await expect(prisma.platConRisk.findMany({})).rejects.toThrow(/Unscoped/);
    await expect(prisma.platDecision.count({})).rejects.toThrow(/Unscoped/);
    await expect(prisma.platConVendor.findFirst({})).rejects.toThrow(/Unscoped/);
    await expect(
      prisma.platConBudgetLine.aggregate({ _sum: { budgetAmount: true } }),
    ).rejects.toThrow(/Unscoped/);
  });

  it("blocks creates that omit orgId", async () => {
    await expect(
      // @ts-expect-error — deliberately missing orgId
      prisma.platConVendor.create({ data: { name: "no org" } }),
    ).rejects.toThrow(/must set orgId/);
  });
});

describe("cross-org writes and reads are refused", () => {
  let actionIdA: number;

  it("A creates its own record", async () => {
    const r = await writeRecord(A, { table: "action", op: "create", data: { title: "A's action" }, actor });
    expect(r.status).toBe("executed");
    actionIdA = r.recordId as number;
  });

  it("B cannot update A's record", async () => {
    await expect(
      writeRecord(B, { table: "action", op: "update", recordId: actionIdA, data: { status: "done" }, actor }),
    ).rejects.toThrow(/not found in this organisation/);
  });

  it("B cannot read A's record; A can", async () => {
    expect(await readRecord(B, "action", actionIdA)).toBeNull();
    const own = await readRecord(A, "action", actionIdA);
    expect(own?.title).toBe("A's action");
  });

  it("B cannot execute A's proposal; A can", async () => {
    const prop = await writeRecord(A, {
      table: "action",
      op: "update",
      recordId: actionIdA,
      data: { status: "done" },
      actor: { type: "ai", name: "bot" },
      requireApproval: true,
    });
    await expect(executeProposal(B, prop.proposalId!, "B-user")).rejects.toThrow(/not found/);
    const done = await executeProposal(A, prop.proposalId!, "A-user");
    expect(done.status).toBe("executed");
  });
});

describe("encrypted token storage", () => {
  it("stores ciphertext at rest, decrypts on read, and is org-scoped", async () => {
    const token = "xoxb-A-secret-oauth-token";
    await saveAccountingToken(A, "xero", token, "A Ledger");

    // The stored column must be ciphertext — never the plaintext token.
    const row = await prisma.platConAccountingConnection.findFirst({ where: { orgId: A.orgId } });
    expect(row?.accessToken).toBeTruthy();
    expect(row?.accessToken).not.toContain(token);
    expect(row?.accessToken?.startsWith("v1:")).toBe(true);

    // A decrypts its own token; B sees nothing.
    expect(await loadAccountingToken(A)).toBe(token);
    expect(await loadAccountingToken(B)).toBeNull();
  });
});

describe("RBAC — demo mode resolves the org's admin", () => {
  it("getCurrentUser/requireAdmin pick an admin even when other roles exist", async () => {
    // Team lives in the control plane (PlatCtlTeamMember, slug-keyed) as of
    // migration-plan Phase 3. Not FK-cascaded with the org — clean explicitly.
    await prisma.platCtlTeamMember.deleteMany({ where: { orgSlug: A.orgSlug } });
    await prisma.platCtlTeamMember.create({
      data: { orgSlug: A.orgSlug, name: "Reader", role: "readonly", email: "reader@iso.test" },
    });
    await prisma.platCtlTeamMember.create({
      data: { orgSlug: A.orgSlug, name: "Boss", role: "admin", email: "boss@iso.test" },
    });
    // Legacy "admin" normalizes to "owner" (see normalizeTeamRole), which is the
    // role the admin gate (isAdminRole) recognises.
    const user = await getCurrentUser(A);
    expect(user.role).toBe("owner");
    const admin = await requireAdmin(A);
    expect(admin.role).toBe("owner");
  });
});
