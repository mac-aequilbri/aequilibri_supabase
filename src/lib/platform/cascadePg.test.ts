// Migration-plan Phase 3 (item 8): the cascade engine on the Postgres store.
// End-to-end through writeRecord's post-write hook: seeding, write-effect
// rules D (procurement→cashflow upsert), F (blocker→phase RAG floor),
// G (risk→materialisation issue), advisory record/load/dismiss, and the
// rule-firing bookkeeping (markRuleApplied).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaUnscoped } from "@/lib/db";
import { writeRecord } from "@/lib/platform/recordWriter";
import {
  dismissCascadeAdvisory,
  loadCascadeAdvisories,
  seedCascadeRules,
} from "@/lib/platform/cascade";
import type { OrgCtx } from "@/lib/platform/types";

const SLUG = "test-cascade-pg";
let ctx: OrgCtx;
let jobId: number;
const actor = { type: "human" as const, name: "cascade-pg-suite" };

beforeAll(async () => {
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: SLUG } });
  const org = await prisma.platOrganisation.create({
    data: { slug: SLUG, name: "Cascade PG Test Org" },
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
  const job = await prisma.platJob.create({
    data: { orgId: org.id, code: "CAS-1", name: "Cascade Test Job" },
  });
  jobId = job.id;
});

afterAll(async () => {
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: SLUG } });
});

describe("cascade engine on Postgres", () => {
  it("seeds the 7 rules idempotently (advisories active, write rules draft)", async () => {
    expect(await seedCascadeRules(ctx)).toBe(7);
    expect(await seedCascadeRules(ctx)).toBe(0); // idempotent
    const rules = await prisma.platLearningRule.findMany({
      where: { orgId: ctx.orgId, ruleCode: { startsWith: "CASCADE-" } },
    });
    expect(rules).toHaveLength(7);
    expect(rules.filter((r) => r.isActive)).toHaveLength(4); // A/B/C/E advisories
    // Owner activates the write-effect rules for the tests below.
    await prisma.platLearningRule.updateMany({
      where: { orgId: ctx.orgId, ruleCode: { in: ["CASCADE-D", "CASCADE-F", "CASCADE-G"] } },
      data: { isActive: true },
    });
  });

  it("rule D: procurement Paid upserts the marker cashflow txn (idempotent)", async () => {
    const res = await writeRecord(ctx, {
      table: "procurement",
      op: "create",
      data: { jobId, item: "Concrete supply", qty: 10, unitPrice: 500, total: 5000, status: "paid" },
      actor,
    });
    const procId = Number(res.recordId);
    const marker = `cascade:${procId}`;
    const txn = await prisma.platConCashflowLedger.findFirst({
      where: { orgId: ctx.orgId, notes: { contains: marker } },
    });
    expect(txn).not.toBeNull();
    expect(txn!.type).toBe("Out");
    expect(txn!.status).toBe("Paid");
    expect(Number(txn!.amount)).toBe(5000);
    expect(txn!.category).toBe("Procurement");

    // Re-fire (amount changed, still paid) → the SAME txn updates, no duplicate.
    await writeRecord(ctx, {
      table: "procurement",
      op: "update",
      recordId: procId,
      data: { total: 6000, status: "paid" },
      actor,
    });
    const txns = await prisma.platConCashflowLedger.findMany({
      where: { orgId: ctx.orgId, notes: { contains: marker } },
    });
    expect(txns).toHaveLength(1);
    expect(Number(txns[0].amount)).toBe(6000);
  });

  it("rule G: risk materialised creates the linked issue once", async () => {
    const res = await writeRecord(ctx, {
      table: "risk",
      op: "create",
      data: { jobId, description: "Supplier insolvency", status: "open" },
      actor,
    });
    const riskId = Number(res.recordId);
    await writeRecord(ctx, {
      table: "risk",
      op: "update",
      recordId: riskId,
      data: { status: "materialised" },
      actor,
    });
    const issues = await prisma.platActionHub.findMany({
      where: { orgId: ctx.orgId, issueType: "Risk Materialised", riskId },
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].title).toContain("Supplier insolvency");
    expect(issues[0].priority).toBe("P1");

    // Re-fire → still exactly one.
    await writeRecord(ctx, {
      table: "risk",
      op: "update",
      recordId: riskId,
      data: { status: "materialised" },
      actor,
    });
    expect(
      await prisma.platActionHub.count({
        where: { orgId: ctx.orgId, issueType: "Risk Materialised", riskId },
      }),
    ).toBe(1);
  });

  it("rule F: a Blocker issue floors the linked phase RAG at Amber", async () => {
    const phaseRes = await writeRecord(ctx, {
      table: "phase",
      op: "create",
      data: { jobId, name: "Frame", status: "in_progress", rag: "Green" },
      actor,
    });
    const phaseId = Number(phaseRes.recordId);
    await writeRecord(ctx, {
      table: "action",
      op: "create",
      data: { jobId, title: "Truss delivery blocked", issueType: "Blocker", phaseId },
      actor,
    });
    const phase = await prisma.platConPhase.findFirst({ where: { id: phaseId, orgId: ctx.orgId } });
    expect(phase!.rag).toBe("Amber");
  });

  it("advisories record, surface and dismiss on the PG store", async () => {
    // CASCADE-B (vendor changed) seeds active — any vendor write advises.
    await writeRecord(ctx, {
      table: "vendor",
      op: "create",
      data: { name: "SteelCo" },
      actor,
    });
    const advisories = await loadCascadeAdvisories(ctx);
    const mine = advisories.find((a) => a.ruleCode === "CASCADE-B");
    expect(mine).toBeDefined();

    await dismissCascadeAdvisory(ctx, mine!.id, actor, false);
    const after = await loadCascadeAdvisories(ctx);
    expect(after.find((a) => a.id === mine!.id)).toBeUndefined();
  });

  it("bumps the fired rule's bookkeeping (markRuleApplied on PG)", async () => {
    const ruleD = await prisma.platLearningRule.findFirst({
      where: { orgId: ctx.orgId, ruleCode: "CASCADE-D" },
    });
    expect(ruleD!.timesTriggered).toBeGreaterThanOrEqual(2); // fired twice above
    expect(ruleD!.confidence).toBeGreaterThan(80);
  });
});
