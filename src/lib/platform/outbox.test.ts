// emitOutboundEvent gating + best-effort behaviour, and the outbox redrive/DLQ
// sweep — fully mocked (no Airtable, no DB).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgCtx } from "./types";

const h = vi.hoisted(() => ({
  controlEnabled: vi.fn(),
  hasActiveOutbound: vi.fn(),
  enqueueOutbox: vi.fn(),
  listFailedOutbox: vi.fn(),
  setOutboxStatus: vi.fn(),
}));

vi.mock("@/lib/platform/controlPlane", () => ({
  controlPlaneEnabled: h.controlEnabled,
  hasActiveOutbound: h.hasActiveOutbound,
  enqueueOutbox: h.enqueueOutbox,
  listFailedOutbox: h.listFailedOutbox,
  setOutboxStatus: h.setOutboxStatus,
}));

// logIntegrationAudit writes to EXECUTION_LOG — stub both backends so no real I/O.
vi.mock("@/lib/db", () => ({ prisma: { platExecutionLog: { create: vi.fn() } } }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() }, errMeta: () => ({}) }));

import { emitOutboundEvent, outboxRedriveTarget, redriveOutbox } from "./outbox";

const ctx = { orgId: 1, orgSlug: "acme" } as unknown as OrgCtx;

beforeEach(() => {
  vi.clearAllMocks();
  h.controlEnabled.mockReturnValue(true);
  h.hasActiveOutbound.mockResolvedValue(true);
  h.enqueueOutbox.mockResolvedValue(undefined);
  h.listFailedOutbox.mockResolvedValue([]);
  h.setOutboxStatus.mockResolvedValue(undefined);
});

describe("emitOutboundEvent", () => {
  it("no-ops when control is off", async () => {
    h.controlEnabled.mockReturnValue(false);
    await emitOutboundEvent(ctx, "report.ready", { entityType: "weekly_report", entityId: 5 });
    expect(h.hasActiveOutbound).not.toHaveBeenCalled();
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("no-ops when the org has no active outbound connection", async () => {
    h.hasActiveOutbound.mockResolvedValue(false);
    await emitOutboundEvent(ctx, "report.ready", { entityType: "weekly_report", entityId: 5 });
    expect(h.enqueueOutbox).not.toHaveBeenCalled();
  });

  it("enqueues a normalized row when an outbound connection is active", async () => {
    await emitOutboundEvent(ctx, "decision.create", {
      entityType: "decision",
      entityId: "rec123",
      jobId: 7,
      summary: "s",
      data: { approvedBy: "Mac" },
    });
    expect(h.enqueueOutbox).toHaveBeenCalledTimes(1);
    expect(h.enqueueOutbox).toHaveBeenCalledWith({
      orgSlug: "acme",
      event: "decision.create",
      entityType: "decision",
      entityId: "rec123",
      jobId: "7",
      summary: "s",
      data: { approvedBy: "Mac" },
    });
  });

  it("coerces a missing entityId to empty string and leaves jobId undefined", async () => {
    await emitOutboundEvent(ctx, "x.y", { entityType: "x", entityId: undefined });
    expect(h.enqueueOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "", jobId: undefined }),
    );
  });

  it("swallows a throw from enqueueOutbox (never rejects into a write path)", async () => {
    h.enqueueOutbox.mockRejectedValue(new Error("airtable down"));
    await expect(
      emitOutboundEvent(ctx, "report.ready", { entityType: "weekly_report", entityId: 5 }),
    ).resolves.toBeUndefined();
  });
});

describe("outboxRedriveTarget", () => {
  it("re-drives below the cap and dead-letters at/above it", () => {
    expect(outboxRedriveTarget(0, 5)).toBe("pending");
    expect(outboxRedriveTarget(4, 5)).toBe("pending");
    expect(outboxRedriveTarget(5, 5)).toBe("dead");
    expect(outboxRedriveTarget(9, 5)).toBe("dead");
  });
});

describe("redriveOutbox", () => {
  it("no-ops when control is off", async () => {
    h.controlEnabled.mockReturnValue(false);
    const r = await redriveOutbox(5);
    expect(r).toEqual({ redriven: 0, deadLettered: 0 });
    expect(h.listFailedOutbox).not.toHaveBeenCalled();
  });

  it("re-drives under-cap rows and dead-letters over-cap rows", async () => {
    h.listFailedOutbox.mockResolvedValue([
      { recordId: "r1", attempts: 1 },
      { recordId: "r2", attempts: 5 },
      { recordId: "r3", attempts: 2 },
    ]);
    const r = await redriveOutbox(5);
    expect(r).toEqual({ redriven: 2, deadLettered: 1 });
    expect(h.setOutboxStatus).toHaveBeenCalledWith("r1", "pending");
    expect(h.setOutboxStatus).toHaveBeenCalledWith("r2", "dead");
    expect(h.setOutboxStatus).toHaveBeenCalledWith("r3", "pending");
  });

  it("keeps sweeping when one row's status update throws", async () => {
    h.listFailedOutbox.mockResolvedValue([
      { recordId: "bad", attempts: 1 },
      { recordId: "ok", attempts: 1 },
    ]);
    h.setOutboxStatus.mockImplementation((id: string) =>
      id === "bad" ? Promise.reject(new Error("boom")) : Promise.resolve(),
    );
    const r = await redriveOutbox(5);
    expect(r).toEqual({ redriven: 1, deadLettered: 0 }); // only "ok" counted
    expect(h.setOutboxStatus).toHaveBeenCalledTimes(2);
  });
});
