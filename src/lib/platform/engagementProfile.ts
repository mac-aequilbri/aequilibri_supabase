// Engagement profiles — the read layer that finally makes ENGAGEMENT_TYPE_CONFIG
// real (Spec 12 Tier 3 / Module 5; docs/spec12-lock-plan.md §5.3). The table has
// been seeded at onboarding since spec-12 provisioning but was never consumed;
// this module resolves an engagement type to the construct-depth flags the spec
// defines per type (which PLAN rendering mode applies, whether the full RISKS
// register is active, cashflow granularity, portfolio activation).
//
// Resolution order: an Active ENGAGEMENT_TYPE_CONFIG row for the type wins;
// otherwise the spec's four engagement-type defaults apply. There is no
// Postgres ENGAGEMENT_TYPE_CONFIG source yet, so the defaults always govern.

import type { EngagementType, OrgCtx } from "./types";

/** PLAN rendering mode — Spec 12 Module 8's four modes of one view component. */
export type PlanViewMode = "gantt" | "checklist" | "workflow" | "season";

export interface EngagementProfile {
  engagementType: EngagementType;
  planView: PlanViewMode;
  /** Full RISKS register active (false = risk flags ride inline on ISSUES). */
  fullRiskRegister: boolean;
  /** Cashflow period granularity label (free text, e.g. "monthly"). */
  cashflowPeriod: string;
  /** Portfolio View activation (Spec 12 Module 8 — explicit flag, never
   *  auto-on; lock decision D-11). True when any Active config row opts in. */
  portfolioView: boolean;
}

/** Spec 12 Module 5 "Engagement type configuration" defaults, applied when no
 *  Active ENGAGEMENT_TYPE_CONFIG row overrides them. */
export function defaultProfileFor(type: EngagementType): EngagementProfile {
  switch (type) {
    case "short_job":
      return { engagementType: type, planView: "checklist", fullRiskRegister: false, cashflowPeriod: "deposit/final", portfolioView: false };
    case "ongoing":
      return { engagementType: type, planView: "workflow", fullRiskRegister: true, cashflowPeriod: "monthly", portfolioView: false };
    case "seasonal":
      return { engagementType: type, planView: "season", fullRiskRegister: true, cashflowPeriod: "seasonal", portfolioView: false };
    case "long_project":
      return { engagementType: type, planView: "gantt", fullRiskRegister: true, cashflowPeriod: "monthly", portfolioView: false };
    default:
      // "general" and anything unrecognised: safest shallow rendering, full registers.
      return { engagementType: type, planView: "checklist", fullRiskRegister: true, cashflowPeriod: "monthly", portfolioView: false };
  }
}

/** App engagement-type key from a stored cell ("Long Project" ↔ long_project). */
export function normalizeEngagementType(v: unknown): EngagementType | "" {
  const s = (typeof v === "string" ? v : "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "short_job" || s === "long_project" || s === "ongoing" || s === "seasonal" || s === "general") return s;
  if (s === "ongoing_lifecycle") return "ongoing";
  if (s === "seasonal_cycle") return "seasonal";
  return "";
}

interface ConfigRow {
  engagementType: EngagementType | "";
  active: boolean;
  planView: PlanViewMode | "";
  fullRiskRegister: boolean | null;
  cashflowPeriod: string;
  portfolioView: boolean;
}

/** Pure overlay half (unit-testable): defaults for the type, overridden by its
 *  Active config row where the row actually says something. Portfolio View is
 *  org-level — any Active row opting in activates it. */
export function resolveProfile(type: EngagementType, rows: readonly ConfigRow[]): EngagementProfile {
  const base = defaultProfileFor(type);
  const row = rows.find((r) => r.active && r.engagementType === type);
  const portfolioView = rows.some((r) => r.active && r.portfolioView);
  if (!row) return { ...base, portfolioView };
  return {
    engagementType: type,
    planView: row.planView || base.planView,
    fullRiskRegister: row.fullRiskRegister ?? base.fullRiskRegister,
    cashflowPeriod: row.cashflowPeriod || base.cashflowPeriod,
    portfolioView,
  };
}

/** Resolve the profile for an engagement type (default: the org's default
 *  type). No config rows exist without an ENGAGEMENT_TYPE_CONFIG source, so
 *  the spec defaults always apply. */
export async function getEngagementProfile(
  ctx: OrgCtx,
  engagementType?: EngagementType | "",
): Promise<EngagementProfile> {
  const type = engagementType || ctx.defaultEngagementType;
  return resolveProfile(type, []);
}

/** Invalidate after ENGAGEMENT_TYPE_CONFIG writes (onboarding, admin edits).
 *  No-op — there is no cache now that the config read is constant. */
export function invalidateEngagementProfiles(_orgSlug: string): void {}
