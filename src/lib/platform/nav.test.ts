import { describe, expect, it } from "vitest";
import { buildNav } from "./nav";
import type { OrgCtx } from "./types";

/** Dulong Downs' shape: one real project, single allowed engagement type. */
const didi = {
  orgSlug: "dulong-downs-didi",
  defaultEngagementType: "long_project",
  allowedEngagementTypes: ["long_project"],
  config: { assistant: { name: "Didi", persona: "" }, features: {} },
} as unknown as OrgCtx;

const hasProjects = (ctx: OrgCtx, jobCount: number) =>
  buildNav(ctx, jobCount)
    .flatMap((s) => s.items)
    .some((i) => i.href.endsWith("/projects"));

describe("buildNav — the Organisation-wide bucket must not create a projects list", () => {
  // The regression: the bucket is stored as a job row, so an org with ONE
  // project counted two, flipped `multiJob`, and grew a Projects menu it was
  // never meant to have. navCountsSource now excludes the bucket from the
  // count that feeds this — so the count arriving here is real projects only.
  it("a single-project org gets NO projects entry", () => {
    expect(hasProjects(didi, 1)).toBe(false);
  });

  it("counting the bucket as a project is what used to break it", () => {
    expect(hasProjects(didi, 2)).toBe(true);
  });

  it("a genuinely multi-project org still gets the list", () => {
    expect(hasProjects(didi, 3)).toBe(true);
  });

  it("orgs with several engagement types keep the list regardless of count", () => {
    const multi = {
      ...didi,
      allowedEngagementTypes: ["long_project", "short_job"],
    } as unknown as OrgCtx;
    expect(hasProjects(multi, 1)).toBe(true);
  });
});
