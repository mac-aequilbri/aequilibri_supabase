// Learning Loop data source for the learning-rules page.
//
// Split by where each datum actually lives after the P2 migration:
//   • LEARNING_RULES — the durable, validated knowledge — read from Airtable
//     when AIRTABLE_MIGRATION is on (the engine writes/reads it there too, so
//     page and engine agree). The read here is the inverse of the learning_rule
//     field map (fieldMaps.ts) — no longer guesswork.
//   • HYPOTHESES / CORRECTIONS / INTELLIGENCE_SNAPSHOT — the loop machinery —
//     remain Postgres "engine state" (relational, numeric ids, and the
//     canonical Airtable schema lacks a Corrections→Hypotheses link to cluster
//     by), so they are read from Postgres in BOTH modes.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import {
  deriveHypothesisType,
  HYPOTHESIS_TYPES,
  parseApplicationWindow,
  parseOverrideLevel,
  relaxEligible,
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

const RULE_ACTIVE_STATUSES = new Set(["Published", "Updated"]);

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

async function rulesFromAirtable(ctx: OrgCtx): Promise<RuleView[]> {
  const rows = await core.list(ctx.orgSlug, "LEARNING_RULES", { maxRecords: 500 });
  return rows
    .map((r) => {
      const ruleStatus = str(r["Rule_Status"]);
      const isActive = RULE_ACTIVE_STATUSES.has(ruleStatus);
      const confidence = num(r["Confidence_Level"]);
      const overrideLevel = parseOverrideLevel(r["Override_Level"], r["Override_Permission"] === false);
      const window = parseApplicationWindow(r["Application_Window"]);
      return {
        id: r.id,
        ruleCode: str(r["Instance"]),
        description: str(r["Rule_Description"]) || str(r["Rule_Name"]),
        kind: str(r["Rule_Type"]).toLowerCase() === "adjustment" ? "adjustment" : "guidance",
        confidence,
        timesTriggered: num(r["Times_Triggered"]),
        isActive,
        autoApply: str(r["Applies_To"]) === "AI Layer Only",
        cannotOverride: r["Override_Permission"] === false,
        status: (isActive
          ? "active"
          : ruleStatus === "Under Review"
            ? "under_review"
            : "draft") as RuleView["status"],
        needsReview: isActive && confidence <= RULE_REVIEW_FLAG_AT,
        overrideLevel,
        relaxEligible: relaxEligible(overrideLevel, window),
      };
    })
    .sort((a, b) => Number(b.isActive) - Number(a.isActive) || b.confidence - a.confidence);
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

async function engineFromAirtable(ctx: OrgCtx): Promise<EngineCounts> {
  const [hypRows, corrRows] = await Promise.all([
    core.list(ctx.orgSlug, "HYPOTHESES", { maxRecords: 500 }),
    core.list(ctx.orgSlug, "CORRECTIONS", { maxRecords: 1000 }),
  ]);
  const hypotheses: HypothesisView[] = hypRows
    .filter((h) => ["pending", "validated"].includes(str(h["Status"]) || "pending"))
    .map((h) => {
      let meta: Record<string, unknown> = {};
      try {
        meta = (JSON.parse(str(h["Evidence"]) || "{}") as Record<string, unknown>) || {};
      } catch {
        /* malformed Evidence */
      }
      const typeField = str(h["Hypothesis_Type"]) || str(meta.hypothesisType);
      const hypothesisType = (HYPOTHESIS_TYPES as readonly string[]).includes(typeField)
        ? (typeField as HypothesisType)
        : "Domain Pattern";
      return {
        id: h.id,
        description: str(h["Summary_of_Findings"]) || str(h["Hypothesis_Name"]),
        dimension: typeof meta.dimension === "string" ? meta.dimension : "",
        sampleCount: num(h["Evidence_Count"]),
        avgVariancePct: typeof meta.avgVariancePct === "number" ? meta.avgVariancePct : 0,
        confidence: num(h["Confidence"]),
        hypothesisType,
        validationThreshold: VALIDATION_THRESHOLDS[hypothesisType],
        validated: str(h["Status"]) === "validated",
      };
    })
    .sort((a, b) => b.confidence - a.confidence);
  const unclustered = corrRows.filter(
    (c) => !Array.isArray(c["Hypothesis"]) || (c["Hypothesis"] as unknown[]).length === 0,
  ).length;
  return { hypotheses, correctionsCount: corrRows.length, unclustered };
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

async function snapshotsFromAirtable(ctx: OrgCtx): Promise<SnapshotView[]> {
  const recs = await core.list(ctx.orgSlug, "INTELLIGENCE_SNAPSHOT", { maxRecords: 50 });
  return recs
    .map((r) => {
      // Rich metrics ride in Accuracy_Summary JSON (snapshotIntelligence); the
      // canonical columns alone lack accuracy/autoApply/avgConfidence.
      let m: Record<string, unknown> = {};
      try {
        m = (JSON.parse(str(r["Accuracy_Summary"]) || "{}") as Record<string, unknown>) || {};
      } catch {
        /* malformed */
      }
      const when = str(r["Snapshot_Date"]) || str(r["Date_Created"]);
      return {
        id: r.id,
        capturedAt: when ? new Date(when) : null,
        accuracyRatePct: typeof m.accuracyRatePct === "number" ? m.accuracyRatePct : null,
        activeRules: typeof m.activeRules === "number" ? m.activeRules : num(r["Total_Active_Rules"]),
        autoApplyRules: typeof m.autoApplyRules === "number" ? m.autoApplyRules : 0,
        avgConfidence: typeof m.avgConfidence === "number" ? m.avgConfidence : 0,
        gaps: Array.isArray(m.gaps) ? m.gaps.map(String) : str(r["Known_Gaps"]) ? [str(r["Known_Gaps"])] : [],
      };
    })
    .sort((a, b) => (b.capturedAt?.getTime() ?? 0) - (a.capturedAt?.getTime() ?? 0))
    .slice(0, 24);
}

/** Load the learning-loop data: rules + the corrections/hypotheses loop from the
 *  active backend; the snapshot history always from Postgres. */
export async function loadLearning(ctx: OrgCtx): Promise<LearningData> {
  const on = airtableEnabled(ctx);
  const [rules, engine, snapshots] = await Promise.all([
    on ? rulesFromAirtable(ctx) : rulesFromPostgres(ctx),
    on ? engineFromAirtable(ctx) : engineFromPostgres(ctx),
    on ? snapshotsFromAirtable(ctx) : snapshotsFromPostgres(ctx),
  ]);
  return { rules, ...engine, snapshots };
}
