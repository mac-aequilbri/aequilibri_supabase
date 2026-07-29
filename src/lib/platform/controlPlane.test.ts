// Migration-plan Phase 3 regression tests: the control-plane repository layer
// against its Postgres store (PlatOrganisation + PlatCtl*). Airtable-mode
// delegation is exercised by the existing mocked suites; these prove the PG
// implementations round-trip, and that RLS scoping resolves from
// PlatCtlAssignment.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaUnscoped } from "@/lib/db";
import {
  addControlAssignment,
  createConnection,
  createControlTeamMember,
  deleteConnection,
  getActiveConnection,
  getOrgRegistry,
  getOrgWebhookSecret,
  hasActiveOutbound,
  enqueueOutbox,
  listConnections,
  listControlAssignments,
  listJobCatalog,
  listOutbox,
  listFailedOutbox,
  setControlAssignments,
  setOrgAiAuthority,
  setOrgWebhookSecret,
  setOutboxStatus,
  setProjectRlsEnforce,
  updateConnection,
} from "./controlPlane";
import { resolveJobScope } from "./rls";
import type { OrgCtx } from "./types";

const SLUG = "test-controlplane";
let ctx: OrgCtx;

function mkCtx(org: { id: number; slug: string; name: string }): OrgCtx {
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

async function cleanup(): Promise<void> {
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: SLUG } });
  await prisma.platCtlTeamMember.deleteMany({ where: { orgSlug: SLUG } });
  await prisma.platCtlAssignment.deleteMany({ where: { orgSlug: SLUG } });
  await prisma.platCtlConnection.deleteMany({ where: { orgSlug: SLUG } });
  await prisma.platCtlOutbox.deleteMany({ where: { orgSlug: SLUG } });
}

beforeAll(async () => {
  await cleanup();
  const org = await prisma.platOrganisation.create({
    data: { slug: SLUG, name: "ControlPlane Test Org" },
  });
  ctx = mkCtx(org);
});

afterAll(cleanup);

describe("org registry (PlatOrganisation store)", () => {
  it("resolves the registry entry and merges settings without clobbering", async () => {
    const entry = await getOrgRegistry(SLUG);
    expect(entry).not.toBeNull();
    expect(entry!.orgId).toBe(ctx.orgId);

    await setOrgWebhookSecret(SLUG, "s3cret");
    await setProjectRlsEnforce(SLUG, true);
    expect(await getOrgWebhookSecret(SLUG)).toBe("s3cret");
    const after = await getOrgRegistry(SLUG);
    const settings = JSON.parse(after!.settings) as {
      webhookSecret?: string;
      features?: Record<string, unknown>;
    };
    expect(settings.webhookSecret).toBe("s3cret"); // survived the second merge
    expect(settings.features?.project_rls_enforce).toBe(true);
  });

  it("updates aiAuthority on the org row", async () => {
    expect(await setOrgAiAuthority(SLUG, "propose_only")).toBe(true);
    const entry = await getOrgRegistry(SLUG);
    expect(entry!.aiAuthority).toBe("propose_only");
  });
});

describe("RLS assignments (PlatCtlAssignment store)", () => {
  const viewer = { email: "worker@cp.test", role: "builder" };

  it("resolves fail-open with no assignments, scoped once assigned", async () => {
    await createControlTeamMember(SLUG, { name: "W", email: viewer.email, role: "builder" });

    // features.project_rls_enforce was set true above → no assignments means
    // the member sees only General (none here) — fail-closed.
    const ctxEnforced = {
      ...ctx,
      config: { ...ctx.config, features: { project_rls_enforce: true } },
    };
    expect((await resolveJobScope(ctxEnforced, viewer)).mode).toBe("none");

    await setControlAssignments(SLUG, viewer.email, ["101", "102"]);
    const scoped = await resolveJobScope(ctxEnforced, viewer);
    expect(scoped.mode).toBe("some");
    if (scoped.mode === "some") {
      expect([...scoped.jobIds].sort()).toEqual(["101", "102"]);
    }
  });

  it("addControlAssignment is idempotent and case-insensitive", async () => {
    await addControlAssignment(SLUG, "WORKER@CP.TEST", "101");
    await addControlAssignment(SLUG, viewer.email, "103");
    const rows = await listControlAssignments(SLUG);
    const mine = rows.filter((a) => a.email === viewer.email).map((a) => a.jobRecId);
    expect(mine.sort()).toEqual(["101", "102", "103"]);
  });

  it("setControlAssignments replaces (empty list clears)", async () => {
    await setControlAssignments(SLUG, viewer.email, []);
    const rows = await listControlAssignments(SLUG);
    expect(rows.filter((a) => a.email === viewer.email)).toHaveLength(0);
  });
});

describe("connections + outbox (PlatCtlConnection/PlatCtlOutbox stores)", () => {
  it("connection lifecycle drives the outbound gate", async () => {
    expect(await hasActiveOutbound(SLUG)).toBe(false);
    await createConnection({ orgSlug: SLUG, channel: "email", direction: "out" });
    expect(await hasActiveOutbound(SLUG)).toBe(true);
    const active = await getActiveConnection(SLUG, "email", "out");
    expect(active).not.toBeNull();

    await updateConnection(active!.recordId, { isActive: false });
    expect(await hasActiveOutbound(SLUG)).toBe(false);
    expect(await getActiveConnection(SLUG, "email", "out")).toBeNull();

    await deleteConnection(active!.recordId);
    expect(await listConnections(SLUG)).toHaveLength(0);
  });

  it("outbox enqueue → list → fail → redrive status flip", async () => {
    await enqueueOutbox({
      orgSlug: SLUG,
      event: "proposal.approved",
      entityType: "decision",
      entityId: "42", // PG-native numeric id as string
      summary: "test event",
    });
    const rows = await listOutbox(SLUG);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].entityId).toBe("42");

    await setOutboxStatus(rows[0].recordId, "failed");
    const failed = await listFailedOutbox();
    expect(failed.some((r) => r.recordId === rows[0].recordId)).toBe(true);
    await setOutboxStatus(rows[0].recordId, "pending");
    expect((await listOutbox(SLUG))[0].status).toBe("pending");
  });
});

describe("job catalog (PlatCtlJobCatalog store)", () => {
  it("lists the seeded construction catalog when present", async () => {
    // Seeded by scripts/seed-control-plane.mjs in dev; tolerate empty DBs.
    const rows = await listJobCatalog("construction");
    for (const r of rows) {
      expect(r.key).toBeTruthy();
      expect(r.isActive).toBe(true);
    }
  });
});
