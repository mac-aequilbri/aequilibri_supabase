import { describe, expect, it } from "vitest";
import {
  GENERAL_ENGAGEMENT_TYPE,
  GENERAL_LABEL,
  excludeGeneral,
  generalJobId,
  isGeneralJob,
} from "./generalJob";
import type { OrgCtx } from "./types";

/** An org whose registry carries the bucket pointer (the provisioned case). */
const withPointer = { orgId: 1, orgSlug: "t", config: { generalJobId: "98" } } as OrgCtx;
/** An org provisioned before the pointer existed — row type is the only marker. */
const noPointer = { orgId: 1, orgSlug: "t", config: {} } as OrgCtx;

describe("generalJobId", () => {
  it("parses the registry's string pointer into a job id", () => {
    expect(generalJobId(withPointer)).toBe(98);
  });

  it("is null when the org has no pointer", () => {
    expect(generalJobId(noPointer)).toBeNull();
  });

  it("rejects junk rather than producing NaN or 0", () => {
    for (const raw of ["", "abc", "0", "-4", "1.5"]) {
      expect(generalJobId({ config: { generalJobId: raw } } as OrgCtx)).toBeNull();
    }
  });

  it("tolerates a ctx with no config at all (webhook-built ctx)", () => {
    expect(generalJobId({} as OrgCtx)).toBeNull();
  });
});

describe("isGeneralJob", () => {
  it("recognises the bucket by engagement type", () => {
    expect(isGeneralJob(noPointer, { id: 5, engagementType: GENERAL_ENGAGEMENT_TYPE })).toBe(true);
  });

  it("recognises the bucket by registry pointer when the type is stale", () => {
    // Airtable JOBS had no type field, so migrated rows can arrive as
    // long_project — the pointer is the fallback identifier.
    expect(isGeneralJob(withPointer, { id: 98, engagementType: "long_project" })).toBe(true);
  });

  it("matches the pointer across the string/number id boundary", () => {
    expect(isGeneralJob(withPointer, { id: "98" })).toBe(true);
  });

  it("leaves real projects alone", () => {
    expect(isGeneralJob(withPointer, { id: 97, engagementType: "long_project" })).toBe(false);
    expect(isGeneralJob(noPointer, { id: 97, engagementType: "long_project" })).toBe(false);
  });
});

describe("excludeGeneral", () => {
  it("excludes by type AND pointer when both are available", () => {
    expect(excludeGeneral(withPointer)).toEqual({
      NOT: { OR: [{ engagementType: GENERAL_ENGAGEMENT_TYPE }, { id: 98 }] },
    });
  });

  it("falls back to type alone when the org has no pointer", () => {
    expect(excludeGeneral(noPointer)).toEqual({
      NOT: { OR: [{ engagementType: GENERAL_ENGAGEMENT_TYPE }] },
    });
  });

  it("never emits an id clause that would match a real project", () => {
    // A null/garbage pointer must not become `{ id: NaN }` or `{ id: 0 }`.
    const where = excludeGeneral({ config: { generalJobId: "nope" } } as OrgCtx);
    expect(where.NOT.OR).toHaveLength(1);
  });
});

describe("the label", () => {
  it("does not read as a project name", () => {
    expect(GENERAL_LABEL).toBe("Organisation-wide");
    expect(GENERAL_LABEL.toLowerCase()).not.toContain("project");
  });
});
