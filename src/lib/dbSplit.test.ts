// §2b rules 2 + 8: db(ctx) tenant resolution and the bounded client cache.
// Connection-free (Prisma clients connect lazily), so this runs anywhere;
// the real cross-database write is proven by the provisioning E2E
// (scripts/provision-tenant-db.mjs) and Phase 5's migration runs.

import { describe, expect, it } from "vitest";
import { db, dbUnscoped, prisma, prismaUnscoped, tenantClientCacheSize } from "./db";

const base = {
  orgId: 999001,
  orgSlug: "db-split-test",
  orgName: "x",
  vertical: "construction",
  defaultEngagementType: "long_project" as const,
  allowedEngagementTypes: ["long_project" as const],
  aiAuthority: "approve_required" as const,
};

describe("db(ctx) tenant resolution", () => {
  it("routes to the shared client without a tenantDatabaseUrl", () => {
    expect(db({ ...base, config: { assistant: { name: "t", persona: "t" }, features: {} } })).toBe(prisma);
    expect(dbUnscoped({ ...base, config: { assistant: { name: "t", persona: "t" }, features: {} } })).toBe(
      prismaUnscoped,
    );
  });

  it("treats a URL equal to DATABASE_URL as the shared client (no extra pool)", () => {
    const ctx = {
      ...base,
      config: {
        assistant: { name: "t", persona: "t" },
        features: {},
        tenantDatabaseUrl: process.env.DATABASE_URL,
      },
    };
    expect(db(ctx)).toBe(prisma);
  });

  it("resolves a provisioned org to a distinct, cached client", () => {
    const url = "postgresql://aequilibri:aequilibri@localhost:5432/db_split_test_fake?schema=public";
    const ctx = {
      ...base,
      config: { assistant: { name: "t", persona: "t" }, features: {}, tenantDatabaseUrl: url },
    };
    const before = tenantClientCacheSize();
    const a = db(ctx);
    expect(a).not.toBe(prisma);
    expect(tenantClientCacheSize()).toBe(before + 1);
    // Same URL again → cache hit, no second pool.
    db(ctx);
    expect(tenantClientCacheSize()).toBe(before + 1);
    // The resolved client still dispatches control models to the control client.
    expect((a as { platOrganisation?: unknown }).platOrganisation).toBeDefined();
    // The guard rides along: unscoped fan-outs throw before touching the DB.
    void expect(a.platJob.findMany({})).rejects.toThrow(/Unscoped platform query/);
  });
});
