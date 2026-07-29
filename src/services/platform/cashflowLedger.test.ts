// Migration-plan Phase 2 regression tests: the Spec-12 cashflow ledger's
// Postgres write path (PlatConCashflowLedger delegate in recordWriter) and
// the PG detail read. Mirrors lifecycle.test.ts's throwaway-org pattern.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, prismaUnscoped } from "@/lib/db";
import { writeRecord } from "@/lib/platform/recordWriter";
import { loadCashflowDetail } from "@/lib/platform/cashflowSource";
import { OrgCtx } from "@/lib/platform/types";

let ctx: OrgCtx;
let jobId: number;
const actor = { type: "human" as const, name: "cashflow-test-suite" };

const SLUGS = ["test-cashflow", "test-cashflow-foreign"];

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

beforeAll(async () => {
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: { in: SLUGS } } });
  const org = await prisma.platOrganisation.create({
    data: { slug: "test-cashflow", name: "Cashflow Test Org" },
  });
  ctx = mkCtx(org);
  const job = await prisma.platJob.create({
    data: { orgId: org.id, code: "CF-1", name: "Ledger Test Job" },
  });
  jobId = job.id;
});

afterAll(async () => {
  await prismaUnscoped.platOrganisation.deleteMany({ where: { slug: { in: SLUGS } } });
});

describe("cashflow ledger writes (Postgres delegate)", () => {
  it("creates a ledger entry with defaults and audits it", async () => {
    const res = await writeRecord(ctx, {
      table: "cashflow",
      op: "create",
      data: { jobId, name: "Deposit", period: "2026-08", type: "In", amount: 5000 },
      actor,
    });
    expect(res.status).toBe("executed");
    const row = await prisma.platConCashflowLedger.findFirst({
      where: { orgId: ctx.orgId, name: "Deposit" },
    });
    expect(row).not.toBeNull();
    expect(row!.jobId).toBe(jobId);
    expect(row!.status).toBe("Forecast"); // zod default
    expect(Number(row!.amount)).toBe(5000);
    const audit = await prisma.platExecutionLog.findFirst({
      where: { orgId: ctx.orgId, targetTable: "plat_con_cashflowledger" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
  });

  it("rejects a malformed period", async () => {
    await expect(
      writeRecord(ctx, {
        table: "cashflow",
        op: "create",
        data: { jobId, name: "Bad period", period: "August 2026", amount: 1 },
        actor,
      }),
    ).rejects.toThrow(/period/i);
  });

  it("updates an entry (status to Paid)", async () => {
    const row = await prisma.platConCashflowLedger.findFirst({
      where: { orgId: ctx.orgId, name: "Deposit" },
    });
    await writeRecord(ctx, {
      table: "cashflow",
      op: "update",
      recordId: row!.id,
      data: { status: "Paid", amount: 4800 },
      actor,
    });
    const updated = await prisma.platConCashflowLedger.findFirst({ where: { id: row!.id, orgId: ctx.orgId } });
    expect(updated!.status).toBe("Paid");
    expect(Number(updated!.amount)).toBe(4800);
  });

  it("serves the PG detail read for the edit form", async () => {
    const row = await prisma.platConCashflowLedger.findFirst({
      where: { orgId: ctx.orgId, name: "Deposit" },
    });
    const detail = await loadCashflowDetail(ctx, String(row!.id));
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("Deposit");
    expect(detail!.status).toBe("Paid");
    expect(detail!.type).toBe("In");
  });

  it("refuses updates against another org's ledger", async () => {
    const foreign = await prisma.platOrganisation.create({
      data: { slug: "test-cashflow-foreign", name: "Foreign Cashflow Org" },
    });
    const row = await prisma.platConCashflowLedger.findFirst({
      where: { orgId: ctx.orgId, name: "Deposit" },
    });
    await expect(
      writeRecord(mkCtx(foreign), {
        table: "cashflow",
        op: "update",
        recordId: row!.id,
        data: { amount: 1 },
        actor,
      }),
    ).rejects.toThrow(/not found in this organisation/);
    await prismaUnscoped.platOrganisation.delete({ where: { id: foreign.id } });
  });
});
