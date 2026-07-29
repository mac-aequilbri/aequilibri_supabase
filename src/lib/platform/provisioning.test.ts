// User provisioning invariants: invite/reactivate semantics, case-insensitive
// email matching, and — most important — the last-active-owner guard that
// prevents an org from locking itself out of admin access.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaUnscoped } from "@/lib/db";
import { inviteMember, listMembers, setMemberActive, setMemberRole } from "./provisioning";
import type { OrgCtx } from "./types";

const SLUG = "test-provisioning";
let ctx: OrgCtx;

beforeAll(async () => {
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: SLUG } });
  // Team rows live in the control plane (PlatCtlTeamMember, slug-keyed) and
  // are not FK-cascaded with the org — clean them explicitly.
  await prisma.platCtlTeamMember.deleteMany({ where: { orgSlug: SLUG } });
  const org = await prisma.platOrganisation.create({
    data: { slug: SLUG, name: "Provisioning Test Org" },
  });
  ctx = {
    orgId: org.id,
    orgSlug: org.slug,
    orgName: org.name,
    vertical: "construction",
    defaultEngagementType: "long_project",
    allowedEngagementTypes: ["long_project"],
    aiAuthority: "approve_required",
    config: { assistant: { name: "T", persona: "t" }, features: {} },
  };
});

afterAll(async () => {
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: SLUG } });
  await prisma.platCtlTeamMember.deleteMany({ where: { orgSlug: SLUG } });
});

describe("inviteMember", () => {
  it("adds a new member (no Clerk in tests → 'added', not 'invited')", async () => {
    const status = await inviteMember(ctx, {
      name: "Alice Owner",
      email: "alice@test-prov.example",
      role: "owner",
    });
    expect(status).toBe("added");
    const members = await listMembers(ctx);
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ email: "alice@test-prov.example", role: "owner", isActive: true });
  });

  it("is idempotent for an active member, matching email case-insensitively", async () => {
    const status = await inviteMember(ctx, {
      name: "Alice Again",
      email: "ALICE@test-prov.example",
      role: "builder",
    });
    expect(status).toBe("already_member");
    expect(await listMembers(ctx)).toHaveLength(1);
  });

  it("normalizes legacy role names on write", async () => {
    await inviteMember(ctx, { name: "Rita Reader", email: "rita@test-prov.example", role: "readonly" });
    const rita = (await listMembers(ctx)).find((m) => m.email.startsWith("rita"));
    expect(rita?.role).toBe("broker");
  });
});

describe("last-active-owner guard", () => {
  it("refuses to demote the only active owner", async () => {
    await expect(setMemberRole(ctx, "alice@test-prov.example", "builder")).rejects.toThrow(
      /only active owner/,
    );
  });

  it("refuses to deactivate the only active owner", async () => {
    await expect(setMemberActive(ctx, "alice@test-prov.example", false)).rejects.toThrow(
      /only active owner/,
    );
  });

  it("allows both once a second active owner exists", async () => {
    await inviteMember(ctx, { name: "Bob Owner", email: "bob@test-prov.example", role: "owner" });
    await setMemberRole(ctx, "alice@test-prov.example", "builder");
    let alice = (await listMembers(ctx)).find((m) => m.email.startsWith("alice"));
    expect(alice?.role).toBe("builder");

    await setMemberActive(ctx, "alice@test-prov.example", false);
    alice = (await listMembers(ctx)).find((m) => m.email.startsWith("alice"));
    expect(alice?.isActive).toBe(false);

    // Bob is now the only active owner — the guard must protect him.
    await expect(setMemberActive(ctx, "bob@test-prov.example", false)).rejects.toThrow(
      /only active owner/,
    );
  });

  it("reactivates a deactivated member via invite, applying the new role", async () => {
    const status = await inviteMember(ctx, {
      name: "Alice Back",
      email: "alice@test-prov.example",
      role: "architect",
    });
    expect(status).toBe("reactivated");
    const alice = (await listMembers(ctx)).find((m) => m.email.startsWith("alice"));
    expect(alice).toMatchObject({ isActive: true, role: "architect" });
  });

  it("throws a clear error for an unknown email", async () => {
    await expect(setMemberRole(ctx, "nobody@test-prov.example", "owner")).rejects.toThrow(
      /No team member/,
    );
  });
});
