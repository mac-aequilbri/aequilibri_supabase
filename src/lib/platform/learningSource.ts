// Learning Loop data source for the learning-rules page. LEARNING_RULES (the
// durable, validated knowledge) and the loop machinery (HYPOTHESES /
// CORRECTIONS / INTELLIGENCE_SNAPSHOT — relational engine state) are all read
// from Postgres.

import { db, prisma } from "@/lib/db";
import {
  deriveHypothesisType,
  RULE_REVIEW_FLAG_AT,
  VALIDATION_THRESHOLDS,
  type HypothesisType,
  type OverrideLevel,
} from "@/services/platform/learning";
import type { OrgCtx } from "./types";

export interface RuleView {
  id: string;
  ruleCode: string;
  description: string;
  kind: string;
  confidence: number;
  timesTriggered: number;
  isActive: boolean;
  autoApply: boolean;
  cannotOverride: boolean;
  /** Draft rules await owner activation; Under Review rules decayed to ≤50. */
  status: "draft" | "active" | "under_review";
  /** Spec 12: confidence at 60 or below flags the rule for owner review. */
  needsReview: boolean;
  /** Spec 12 governance ladder (Owner_Only / Standard / Advisory). */
  overrideLevel: OverrideLevel;
  /** Owner_Only rule with 10 clean applications — suggest relaxing to Standard. */
  relaxEligible: boolean;
}

export interface HypothesisView {
  id: string;
  description: string;
  dimension: string;
  sampleCount: number;
  avgVariancePct: number;
  confidence: number;
  hypothesisType: HypothesisType;
  /** Evidence needed before this hypothesis type validates (Spec 12 Stage 3). */
  validationThreshold: number;
  /** Platform-proposed validation — owner confirms by promoting. */
  validated: boolean;
}

export interface SnapshotView {
  id: string;
  capturedAt: Date | null;
  accuracyRatePct: number | null;
  activeRules: number;
  autoApplyRules: number;
  avgConfidence: number;
  gaps: string[];
}

export interface LearningData {
  rules: RuleView[];
  hypotheses: HypothesisView[];
  correctionsCount: number;
  unclustered: number;
  snapshots: SnapshotView[];
}

function parseGaps(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

async function rulesFromPostgres(ctx: OrgCtx): Promise<RuleView[]> {
  const rules = await db(ctx).platLearningRule.findMany({
    where: { orgId: ctx.orgId },
    orderBy: [{ isActive: "desc" }, { confidence: "desc" }],
  });
  return rules.map((r) => {
    const underReview = !r.isActive && r.notes.startsWith("Under Review");
    return {
      id: String(r.id),
      ruleCode: r.ruleCode,
      description: r.description,
      kind: r.kind,
      confidence: r.confidence,
      timesTriggered: r.timesTriggered,
      isActive: r.isActive,
      autoApply: r.autoApply,
      cannotOverride: r.cannotOverride,
      status: (r.isActive ? "active" : underReview ? "under_review" : "draft") as RuleView["status"],
      needsReview: r.isActive && r.confidence <= RULE_REVIEW_FLAG_AT,
      // Postgres carries no ladder columns — legacy fallback semantics.
      overrideLevel: (r.cannotOverride ? "owner_only" : "standard") as OverrideLevel,
      relaxEligible: false,
    };
  });
}

interface EngineCounts {
  hypotheses: HypothesisView[];
  correctionsCount: number;
  unclustered: number;
}

async function engineFromPostgres(ctx: OrgCtx): Promise<EngineCounts> {
  const [hypotheses, correctionsCount, unclustered] = await Promise.all([
    db(ctx).platHypothesis.findMany({
      where: { orgId: ctx.orgId, status: { in: ["pending", "validated"] } },
      orderBy: { confidence: "desc" },
    }),
    db(ctx).platCorrection.count({ where: { orgId: ctx.orgId } }),
    db(ctx).platCorrection.count({ where: { orgId: ctx.orgId, hypothesisId: null } }),
  ]);
  return {
    hypotheses: hypotheses.map((h) => {
      const hypothesisType = deriveHypothesisType(h.rootCausePattern, h.triggerCondition);
      return {
        id: String(h.id),
        description: h.description,
        dimension: h.dimension,
        sampleCount: h.sampleCount,
        avgVariancePct: h.avgVariancePct,
        confidence: h.confidence,
        hypothesisType,
        validationThreshold: VALIDATION_THRESHOLDS[hypothesisType],
        validated: h.status === "validated",
      };
    }),
    correctionsCount,
    unclustered,
  };
}

async function snapshotsFromPostgres(ctx: OrgCtx): Promise<SnapshotView[]> {
  const snapshots = await db(ctx).platIntelligenceSnapshot.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { capturedAt: "desc" },
    take: 24,
  });
  return snapshots.map((s) => ({
    id: String(s.id),
    capturedAt: s.capturedAt,
    accuracyRatePct: s.accuracyRatePct,
    activeRules: s.activeRules,
    autoApplyRules: s.autoApplyRules,
    avgConfidence: s.avgConfidence,
    gaps: parseGaps(s.gaps),
  }));
}

/** Load the learning-loop data: rules, the corrections/hypotheses loop, and
 *  the snapshot history. */
export async function loadLearning(ctx: OrgCtx): Promise<LearningData> {
  const [rules, engine, snapshots] = await Promise.all([
    rulesFromPostgres(ctx),
    engineFromPostgres(ctx),
    snapshotsFromPostgres(ctx),
  ]);
  return { rules, ...engine, snapshots };
}
