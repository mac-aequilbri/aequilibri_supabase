// Platform learning loop — Spec 12 Module 6 pipeline (Capture → Detect →
// Validate → Promote) over CORRECTIONS → HYPOTHESES → LEARNING_RULES.
//   Detect: corrections cluster on Root_Cause category + Source_Module +
//     (Supplier | Phase) anchor, at per-Hypothesis_Type thresholds.
//   Validate: a hypothesis is proposed as "validated" by the platform when its
//     type's evidence threshold is met with a consistent delta direction; the
//     owner confirms by promoting (or rejects).
//   Promote: promotion creates a DRAFT rule (Rule_Status "Draft") with
//     confidence capped at 85 — no rule becomes Active without owner sign-off
//     (the activate toggle on the learning-rules page).
//   Application: +1 confidence per clean firing (max 95); overrides decay −5
//     (recordRuleOverride); ≤60 flags for review, ≤50 auto Under Review.
// Rules come in two kinds ("adjustment" = numeric, applied by the assessment
// engine; "guidance" = text, injected into the assistant prompt); thresholds
// live in PlatCfgSetting.

import { db, prisma } from "@/lib/db";
import type { RecordId } from "@/lib/platform/recordWriter";
import { OrgCtx } from "@/lib/platform/types";

const S = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

export interface Adjustment {
  type: "dimension_multiplier" | "contingency_pct";
  value: number;
  dimension?: string;
}

export interface LearningSettings {
  hypothesisMinSamples: number;
  ruleMinSamples: number;
  autoApplyConfidence: number;
  autoApplyTriggers: number;
}

const DEFAULTS: LearningSettings = {
  hypothesisMinSamples: 5, // Spec 12 Stage 2 default; per-type thresholds below can lower it
  ruleMinSamples: 5,
  autoApplyConfidence: 85,
  autoApplyTriggers: 50,
};

// ── Spec 12 Module 6 constants ──────────────────────────────────────

export const HYPOTHESIS_TYPES = [
  "Domain Pattern",
  "Supplier Pattern",
  "Estimation Bias",
  "Seasonal Pattern",
  "Scope Creep Pattern",
] as const;
export type HypothesisType = (typeof HYPOTHESIS_TYPES)[number];

/** Validation thresholds per Hypothesis_Type (Spec 12 Stage 3 defaults).
 *  Supplier behaviour repeats, so fewer samples validate it; estimation bias
 *  is noisy, so more are needed. Seasonal Pattern is specified as 2 *seasons*
 *  of calendar recurrence — there is no Season_Year signal in the data yet, so
 *  it is defined here for completeness but never assigned by classification. */
export const VALIDATION_THRESHOLDS: Record<HypothesisType, number> = {
  "Supplier Pattern": 3,
  "Domain Pattern": 5,
  "Estimation Bias": 8,
  "Seasonal Pattern": 2,
  "Scope Creep Pattern": 5,
};

/** Starting confidence at promotion (Spec 12): capped at 85 regardless of
 *  evidence — no rule starts at full confidence. The applications term is 0 at
 *  promotion (Times_Applied_Without_Override starts at 0). */
export function promotionConfidence(evidenceCount: number, type: HypothesisType): number {
  const threshold = VALIDATION_THRESHOLDS[type];
  return Math.min(85, Math.round((evidenceCount / threshold) * 70));
}

export const RULE_CONFIDENCE_MAX = 95; // never 100 — no rule is absolute
export const RULE_OVERRIDE_DECAY = 5;
export const RULE_REVIEW_FLAG_AT = 60; // flagged for review
export const RULE_UNDER_REVIEW_AT = 50; // auto Status = Under Review

// ── Spec 12 Override_Permission governance ladder (lock plan §6.1) ──────────
// Three levels: Owner_Only (only owner/admin may override) · Standard (any
// write role) · Advisory (surfaced as a suggestion, never enforced — a
// cascade write-effect rule at Advisory degrades to a review prompt).
// New rules start Owner_Only. After 10 clean applications the owner MAY relax
// to Standard (suggested in the UI, never automatic). A rule overridden more
// than 3 times in its last 10 applications is demoted one level — not deleted.
//
// Storage: Override_Level (singleSelect) + Application_Window (JSON array of
// 0/1, most recent last, capped at 10) — both additive schema.generated
// hand-patches provisioned by schema-drift migration. Reads are tri-state
// tolerant: absent Override_Level falls back to the legacy checkbox
// (Override_Permission=false → owner_only, else standard); ladder writes are
// best-effort so an unmigrated base keeps today's behaviour exactly.

export type OverrideLevel = "owner_only" | "standard" | "advisory";

export const RULE_LADDER_WINDOW = 10;
export const RULE_DEMOTE_OVERRIDES = 3; // demote when overrides in window exceed this

export function parseApplicationWindow(raw: unknown): boolean[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.slice(-RULE_LADDER_WINDOW).map((v) => v === 1 || v === true);
  } catch {
    return [];
  }
}

export function serializeApplicationWindow(window: readonly boolean[]): string {
  return JSON.stringify(window.slice(-RULE_LADDER_WINDOW).map((v) => (v ? 1 : 0)));
}

export function parseOverrideLevel(raw: unknown, cannotOverride: boolean): OverrideLevel {
  const s = (typeof raw === "string" ? raw : "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "owner_only" || s === "standard" || s === "advisory") return s;
  return cannotOverride ? "owner_only" : "standard";
}

/** Airtable option name for a level ("owner_only" → "Owner_Only"). */
export function overrideLevelOption(level: OverrideLevel): string {
  return level === "owner_only" ? "Owner_Only" : level === "standard" ? "Standard" : "Advisory";
}

/** One step down the ladder (Spec 12: Standard → Owner_Only → Advisory; a rule
 *  is demoted, never deleted — historical intelligence retains value). */
export function demotedLevel(level: OverrideLevel): OverrideLevel {
  return level === "standard" ? "owner_only" : "advisory";
}

/** Push an application (clean=true) / override (clean=false) onto the rolling
 *  window and decide whether the rule demotes. Pure — unit-testable. */
export function ladderAfterEvent(
  level: OverrideLevel,
  window: readonly boolean[],
  clean: boolean,
): { window: boolean[]; level: OverrideLevel; demoted: boolean } {
  const next = [...window, clean].slice(-RULE_LADDER_WINDOW);
  const overrides = next.filter((v) => !v).length;
  const demote = !clean && overrides > RULE_DEMOTE_OVERRIDES && level !== "advisory";
  return { window: next, level: demote ? demotedLevel(level) : level, demoted: demote };
}

/** Owner MAY relax an Owner_Only rule to Standard after 10 applications
 *  without an override (suggested in the learning UI, never automatic). */
export function relaxEligible(level: OverrideLevel, window: readonly boolean[]): boolean {
  return level === "owner_only" && window.length >= RULE_LADDER_WINDOW && window.every(Boolean);
}

const SETTING_KEYS: Record<keyof LearningSettings, string> = {
  hypothesisMinSamples: "learning.hypothesis_min_samples",
  ruleMinSamples: "learning.rule_min_samples",
  autoApplyConfidence: "learning.auto_apply_min_confidence",
  autoApplyTriggers: "learning.auto_apply_min_triggers",
};

async function settingsByKey(ctx: OrgCtx): Promise<Map<string, string>> {
  const rows = await db(ctx).platCfgSetting.findMany({
    where: { orgId: ctx.orgId, key: { in: Object.values(SETTING_KEYS) } },
  });
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function getLearningSettings(ctx: OrgCtx): Promise<LearningSettings> {
  const byKey = await settingsByKey(ctx);
  const out = { ...DEFAULTS };
  for (const [field, key] of Object.entries(SETTING_KEYS) as [keyof LearningSettings, string][]) {
    const raw = byKey.get(key);
    if (raw == null) continue;
    // Settings are stored as a JSON-encoded scalar in Postgres; the Airtable
    // mirror stores the plain value. Parse defensively for both.
    let n = Number(raw);
    if (!Number.isFinite(n)) {
      try {
        n = Number(JSON.parse(raw));
      } catch {
        continue;
      }
    }
    if (Number.isFinite(n) && n > 0) out[field] = n;
  }
  return out;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").trim();

function parseContext(raw: string): Record<string, string> {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// ── Clustering engine (backend-neutral helpers) ─────────────────────

/** Neutral correction shape both backends map into before clustering. Context
 *  is the trigger-key map with the reserved "_"-prefixed loop metadata already
 *  extracted (sourceModule/direction) and stripped. */
interface LoopCorrection {
  id: string;
  dimension: string;
  /** Root_Cause category (Spec 12 five categories; legacy rows: free text). */
  rootCause: string;
  sourceModule: string;
  direction: string;
  variancePct: number | null;
  context: Record<string, string>;
}

/** Split raw context into trigger keys vs reserved loop metadata. */
function splitContext(raw: Record<string, string>): {
  triggers: Record<string, string>;
  sourceModule: string;
  direction: string;
} {
  const triggers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith("_")) triggers[k] = v;
  }
  return { triggers, sourceModule: S(raw["_sourceModule"]), direction: S(raw["_direction"]) };
}

/** Spec 12 Stage 2 detection key: Root_Cause + Source_Module + (same Supplier
 *  or same Phase). Corrections with neither anchor fall back to the dimension
 *  so legacy rows still cluster meaningfully. */
function clusterKey(c: LoopCorrection): string {
  const anchor = c.context["supplier"]
    ? `supplier:${norm(c.context["supplier"])}`
    : c.context["phase"]
      ? `phase:${norm(c.context["phase"])}`
      : `dim:${c.dimension}`;
  return `${norm(c.rootCause)}::${c.sourceModule || "manual"}::${anchor}`;
}

/** Hypothesis_Type from the cluster's anchor and Root_Cause category.
 *  Seasonal Pattern needs a calendar-recurrence signal (Season_Year) that the
 *  data does not carry yet, so it is never assigned here. */
function classifyGroup(group: LoopCorrection[]): HypothesisType {
  const first = group[0];
  if (first.context["supplier"]) return "Supplier Pattern";
  if (first.rootCause === "Scope Change") return "Scope Creep Pattern";
  if (first.rootCause === "Estimation Error") return "Estimation Bias";
  return "Domain Pattern";
}

/** Share of the dominant delta direction across the group (0–1). Uses variance
 *  signs when numeric, stored Correction_Direction otherwise; with fewer than
 *  two signals there is nothing to contradict, so the group counts consistent. */
function directionConsistency(group: LoopCorrection[]): number {
  const signs = group
    .map((c) => c.variancePct)
    .filter((v): v is number => v != null && v !== 0)
    .map((v) => (v > 0 ? "+" : "-"));
  const signals = signs.length >= 2 ? signs : group.map((c) => c.direction).filter(Boolean);
  if (signals.length < 2) return 1;
  const counts = new Map<string, number>();
  for (const s of signals) counts.set(s, (counts.get(s) ?? 0) + 1);
  return Math.max(...counts.values()) / signals.length;
}

const DIRECTION_CONSISTENT_AT = 0.8;

interface GroupStats {
  dimension: string; // dominant dimension — adjustments need one
  avgVar: number;
  signedAvg: number;
  trigger: Record<string, string>;
  consistency: number;
}

function groupStats(group: LoopCorrection[]): GroupStats {
  const variances = group.map((c) => c.variancePct).filter((v): v is number => v != null);
  const avgVar = variances.length
    ? Math.round((variances.reduce((s, v) => s + Math.abs(v), 0) / variances.length) * 10) / 10
    : 0;
  const signedAvg = variances.length ? variances.reduce((s, v) => s + v, 0) / variances.length : 0;

  // Trigger condition: context keys whose dominant value covers ≥60% of samples.
  const trigger: Record<string, string> = {};
  const keyCounts = new Map<string, Map<string, number>>();
  for (const c of group) {
    for (const [k, v] of Object.entries(c.context)) {
      if (!v) continue;
      if (!keyCounts.has(k)) keyCounts.set(k, new Map());
      const m = keyCounts.get(k)!;
      m.set(norm(String(v)), (m.get(norm(String(v))) ?? 0) + 1);
    }
  }
  for (const [k, values] of keyCounts) {
    let best = "";
    let n = 0;
    for (const [v, count] of values) if (count > n) { best = v; n = count; }
    if (n / group.length >= 0.6) trigger[k] = best;
  }

  const dimCounts = new Map<string, number>();
  for (const c of group) dimCounts.set(c.dimension, (dimCounts.get(c.dimension) ?? 0) + 1);
  let dimension = group[0].dimension;
  let dimBest = 0;
  for (const [d, n] of dimCounts) if (n > dimBest) { dimension = d; dimBest = n; }

  return { dimension, avgVar, signedAvg, trigger, consistency: directionConsistency(group) };
}

function groupDescription(stats: GroupStats, cause: string): string {
  const direction = stats.signedAvg >= 0 ? "under" : "over";
  return stats.avgVar > 0
    ? `${stats.dimension.replace(/[._]/g, " ")} ${direction}estimated by ~${stats.avgVar}% on average — ${cause || "no root cause"}.`
    : `${stats.dimension.replace(/[._]/g, " ")} repeatedly corrected — ${cause || "no root cause"}.`;
}

/** Stage 3 (Validate): the platform proposes "validated" once the type's
 *  evidence threshold is met with a consistent direction; owner statuses
 *  (active/rejected/promoted) are never downgraded. */
function proposedStatus(
  sampleCount: number,
  type: HypothesisType,
  consistency: number,
  prior?: string,
): string {
  if (prior && prior !== "pending" && prior !== "validated") return prior;
  const validated =
    sampleCount >= VALIDATION_THRESHOLDS[type] && consistency >= DIRECTION_CONSISTENT_AT;
  return validated ? "validated" : "pending";
}

/** Detection gate: Spec 12's Stage 2 default (settings) lowered by the
 *  per-type validation threshold, so e.g. a Supplier Pattern forms at 3. */
function detectThreshold(settings: LearningSettings, type: HypothesisType): number {
  return Math.min(settings.hypothesisMinSamples, VALIDATION_THRESHOLDS[type]);
}

const HYP_OPEN_STATUSES = new Set(["pending", "validated", "active"]);

// ── Hypothesis engine ───────────────────────────────────────────────
// Cluster the org's un-linked corrections by the Spec 12 detection key
// (Root_Cause + Source_Module + Supplier/Phase anchor); form or update a
// hypothesis once the type's detection threshold is met.

export async function runHypothesisEngine(
  ctx: OrgCtx,
): Promise<{ created: number; updated: number }> {
  const settings = await getLearningSettings(ctx);
  const rows = await db(ctx).platCorrection.findMany({
    where: { orgId: ctx.orgId, hypothesisId: null, rootCause: { not: "" } },
  });
  const corrections: (LoopCorrection & { pgId: number })[] = rows.map((c) => {
    const { triggers, sourceModule, direction } = splitContext(parseContext(c.context));
    return {
      id: String(c.id),
      pgId: c.id,
      dimension: c.dimension,
      rootCause: c.rootCause,
      sourceModule,
      direction,
      variancePct: c.variancePct,
      context: triggers,
    };
  });

  const groups = new Map<string, (LoopCorrection & { pgId: number })[]>();
  for (const c of corrections) {
    const key = clusterKey(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }

  let created = 0;
  let updated = 0;
  for (const [, group] of groups) {
    const type = classifyGroup(group);
    if (group.length < detectThreshold(settings, type)) continue;
    const cause = group[0].rootCause;

    const stats = groupStats(group);
    const description = groupDescription(stats, cause);

    // Postgres has no meta column for the cluster key; prior matching stays on
    // (dominant dimension + root cause), which the key subsumes for rows
    // without a supplier/phase anchor.
    const existing = await db(ctx).platHypothesis.findFirst({
      where: {
        orgId: ctx.orgId,
        dimension: stats.dimension,
        rootCausePattern: norm(cause),
        status: { in: [...HYP_OPEN_STATUSES] },
      },
    });

    let hypothesisId: number;
    if (existing) {
      const sampleCount = group.length + existing.sampleCount;
      const h = await db(ctx).platHypothesis.update({
        where: { id: existing.id },
        data: {
          description,
          sampleCount,
          avgVariancePct: stats.avgVar,
          confidence: Math.min(95, sampleCount * 12),
          triggerCondition: JSON.stringify(stats.trigger),
          status: proposedStatus(sampleCount, type, stats.consistency, existing.status),
        },
      });
      hypothesisId = h.id;
      updated++;
    } else {
      const h = await db(ctx).platHypothesis.create({
        data: {
          orgId: ctx.orgId,
          description,
          dimension: stats.dimension,
          rootCausePattern: norm(cause),
          triggerCondition: JSON.stringify(stats.trigger),
          sampleCount: group.length,
          avgVariancePct: stats.avgVar,
          confidence: Math.min(95, group.length * 12),
          status: proposedStatus(group.length, type, stats.consistency),
        },
      });
      hypothesisId = h.id;
      created++;
    }
    await db(ctx).platCorrection.updateMany({
      where: { orgId: ctx.orgId, id: { in: group.map((c) => c.pgId) } },
      data: { hypothesisId },
    });
  }
  return { created, updated };
}

// ── Human gates ─────────────────────────────────────────────────────

export async function setHypothesisStatus(
  ctx: OrgCtx,
  id: RecordId,
  status: "active" | "rejected",
): Promise<void> {
  await db(ctx).platHypothesis.updateMany({
    where: { id: Number(id), orgId: ctx.orgId },
    data: { status, reviewedAt: new Date() },
  });
}

/** Next LRN-#### code for this org: max existing suffix + 1 (count-based
 *  numbering duplicates after deletions). Reads from whichever backend holds the
 *  rules. Concurrent allocations can still collide — the Postgres path retries
 *  under @@unique([orgId, ruleCode]); Airtable has no unique constraint (rare
 *  dup tolerated, matching the rest of the Airtable write path). */
export async function nextRuleCode(ctx: OrgCtx, bump = 0): Promise<string> {
  const rules = await db(ctx).platLearningRule.findMany({
    where: { orgId: ctx.orgId },
    select: { ruleCode: true },
  });
  const max = rules.reduce((m, r) => Math.max(m, Number(r.ruleCode.replace(/\D/g, "")) || 0), 0);
  return `LRN-${String(max + 1 + bump).padStart(4, "0")}`;
}

/** App-shaped rule create payload (a subset of the Prisma create data, shared
 *  with the Airtable field map, plus Airtable-only keys the Postgres path
 *  strips: the source-hypothesis record link and the issue date). */
type RuleCreateData = Omit<
  // Type-level only — the shared client's delegate types are identical to any
  // per-org client's (same schema), so `prisma` is fine here.
  Parameters<typeof prisma.platLearningRule.create>[0]["data"],
  "ruleCode" | "orgId"
> & { sourceHypothesisAirId?: string; dateIssued?: Date };

/** Create a rule with a freshly allocated code. Routes to the org's Airtable
 *  base (via the learning_rule field map) or Postgres (retrying on a unique-code
 *  collision from two concurrent promotions). */
export async function createRuleWithCode(
  ctx: OrgCtx,
  data: RuleCreateData,
): Promise<{ id: string; ruleCode: string }> {
  const { sourceHypothesisAirId: _airHyp, dateIssued: _issued, ...pgData } = data;
  void _airHyp;
  void _issued;
  for (let attempt = 0; attempt < 3; attempt++) {
    const ruleCode = await nextRuleCode(ctx, attempt);
    try {
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      const rule = await db(ctx).platLearningRule.create({ data: { ...(pgData as any), orgId: ctx.orgId, ruleCode } });
      return { id: String(rule.id), ruleCode };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "P2002" || attempt === 2) throw err;
    }
  }
  throw new Error("unreachable");
}

/** Hypothesis_Type for a Postgres hypothesis row (no meta column): derived
 *  from the stored root-cause pattern and whether the trigger carries a
 *  supplier anchor. Mirrors classifyGroup. */
export function deriveHypothesisType(
  rootCausePattern: string,
  triggerCondition: string,
): HypothesisType {
  const trigger = parseContext(triggerCondition);
  if (trigger["supplier"]) return "Supplier Pattern";
  const cause = norm(rootCausePattern);
  if (cause === norm("Scope Change")) return "Scope Creep Pattern";
  if (cause === norm("Estimation Error")) return "Estimation Bias";
  return "Domain Pattern";
}

/** Stage 4 (Promote) — owner-confirmed. Creates a DRAFT rule (never Active;
 *  the owner activates it on the learning-rules page — Spec 12: "No rule
 *  becomes Active without owner sign-off"). Refuses hypotheses that have not
 *  reached their type's validation threshold with a consistent direction.
 *  Starting confidence: min(85, Evidence_Count / Validation_Threshold × 70).
 *  Scope Creep patterns never become adjustments — a scope change does not
 *  update the estimation model. */
export async function promoteHypothesisToRule(
  ctx: OrgCtx,
  id: RecordId,
  kind: "adjustment" | "guidance" = "adjustment",
): Promise<string | null> {
  const h = await db(ctx).platHypothesis.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!h) return null;

  const type = deriveHypothesisType(h.rootCausePattern, h.triggerCondition);
  if (h.sampleCount < VALIDATION_THRESHOLDS[type]) return null; // not validated

  const effectiveKind =
    type !== "Scope Creep Pattern" && h.avgVariancePct !== 0 && kind === "adjustment"
      ? "adjustment"
      : "guidance";

  let adjustment = "{}";
  if (effectiveKind === "adjustment") {
    const corrections = await db(ctx).platCorrection.findMany({
      where: { orgId: ctx.orgId, hypothesisId: h.id, variancePct: { not: null } },
      select: { variancePct: true },
    });
    const signed = corrections.length
      ? corrections.reduce((s, c) => s + (c.variancePct ?? 0), 0) / corrections.length
      : h.avgVariancePct;
    const mult = Math.round((1 + signed / 100) * 1000) / 1000;
    const adj: Adjustment =
      h.dimension === "contingency"
        ? { type: "contingency_pct", value: Math.abs(h.avgVariancePct) }
        : { type: "dimension_multiplier", value: mult, dimension: h.dimension };
    adjustment = JSON.stringify(adj);
  }

  const rule = await createRuleWithCode(ctx, {
    kind: effectiveKind,
    description: h.description,
    dimension: h.dimension,
    triggerCondition: h.triggerCondition,
    adjustment,
    priority: 3,
    confidence: promotionConfidence(h.sampleCount, type),
    isActive: false, // Draft — owner activates
    autoApply: false,
    sourceHypothesisId: h.id,
  });
  await db(ctx).platHypothesis.update({ where: { id: h.id }, data: { status: "promoted" } });
  return rule.id;
}

// ── Application ─────────────────────────────────────────────────────

function ruleMatches(triggerRaw: string, context: Record<string, string>): boolean {
  const trigger = parseContext(triggerRaw);
  for (const [k, v] of Object.entries(trigger)) {
    if (!v) continue;
    const have = norm(String(context[k] ?? ""));
    if (!have.includes(norm(String(v)))) return false;
  }
  return true; // empty trigger matches everything
}

/** Backend-neutral active-rule shape consumed by the engine + assistant. */
export interface RuleRow {
  id: string;
  ruleCode: string;
  kind: string;
  description: string;
  dimension: string;
  triggerCondition: string;
  adjustment: string;
  priority: number;
  confidence: number;
  isActive: boolean;
  autoApply: boolean;
  cannotOverride: boolean;
  timesTriggered: number;
  /** Spec 12 governance ladder (Owner_Only/Standard/Advisory) — legacy rows
   *  fall back from the Override_Permission checkbox. */
  overrideLevel: OverrideLevel;
  /** Rolling last-10 applications (true = applied without override). */
  applicationWindow: boolean[];
  /** Last_Triggered date ("YYYY-MM-DD", "" when never) — the session-close
   *  form uses it to list rules applied today. */
  lastTriggered: string;
}

export async function getActiveRules(ctx: OrgCtx): Promise<RuleRow[]> {
  // Spec 12 session protocol: Active rules sorted by Priority descending.
  const rows = await db(ctx).platLearningRule.findMany({
    where: { orgId: ctx.orgId, isActive: true },
    orderBy: [{ priority: "desc" }, { confidence: "desc" }],
  });
  return rows.map((r) => ({
    id: String(r.id),
    ruleCode: r.ruleCode,
    kind: r.kind,
    description: r.description,
    dimension: r.dimension,
    triggerCondition: r.triggerCondition,
    adjustment: r.adjustment,
    priority: r.priority,
    confidence: r.confidence,
    isActive: r.isActive,
    autoApply: r.autoApply,
    cannotOverride: r.cannotOverride,
    timesTriggered: r.timesTriggered,
    // Postgres has no ladder columns — legacy fallback semantics.
    overrideLevel: (r.cannotOverride ? "owner_only" : "standard") as OverrideLevel,
    applicationWindow: [],
    lastTriggered: "",
  }));
}

/** Read-only: the org's active GUIDANCE rules matching a context, without
 *  firing them (no counter bumps). Used to make AI analysis learning-aware
 *  before the call, complementing the adjustment rules applied afterwards. */
export async function getMatchingGuidance(
  ctx: OrgCtx,
  context: Record<string, string>,
): Promise<{ ruleCode: string; description: string }[]> {
  const rules = await getActiveRules(ctx);
  return rules
    .filter((r) => r.kind === "guidance" && ruleMatches(r.triggerCondition, context))
    .map((r) => ({ ruleCode: r.ruleCode, description: r.description }));
}

export interface AppliedRule {
  ruleCode: string;
  description: string;
  kind: string;
  adjustment: Adjustment | null;
  confidence: number;
  autoApply: boolean;
}

/** Match active rules against a context, log the firings, compound confidence. */
export async function applyRules(
  ctx: OrgCtx,
  context: Record<string, string>,
): Promise<AppliedRule[]> {
  const settings = await getLearningSettings(ctx);
  const rules = await getActiveRules(ctx);
  const applied: AppliedRule[] = [];
  for (const r of rules) {
    if (!ruleMatches(r.triggerCondition, context)) continue;
    let adjustment: Adjustment | null = null;
    if (r.kind === "adjustment") {
      try {
        adjustment = JSON.parse(r.adjustment) as Adjustment;
      } catch {
        adjustment = null;
      }
      if (!adjustment?.type) continue;
    }
    applied.push({
      ruleCode: r.ruleCode,
      description: r.description,
      kind: r.kind,
      adjustment,
      confidence: r.confidence,
      autoApply: r.autoApply,
    });
    // Spec 12: confidence grows by 1 per application without override,
    // capped at RULE_CONFIDENCE_MAX (95) — never 100, no rule is absolute.
    const newConfidence = Math.min(RULE_CONFIDENCE_MAX, r.confidence + 1);
    const newAutoApply =
      newConfidence >= settings.autoApplyConfidence &&
      r.timesTriggered + 1 >= settings.autoApplyTriggers;
    await db(ctx).platLearningRule.update({
      where: { id: Number(r.id) },
      data: {
        timesTriggered: { increment: 1 },
        confidence: newConfidence,
        autoApply: newAutoApply,
      },
    });
  }
  return applied;
}

/** Spec 12 confidence decay: an override costs the rule 5 confidence. At 60
 *  or below the rule is flagged for review (surfaced on the learning-rules
 *  page); at 50 or below it is automatically taken out of application —
 *  Rule_Status "Under Review" in Airtable (excluded from RULE_ACTIVE_STATUSES),
 *  isActive=false in Postgres — pending owner reassessment. Looked up by rule
 *  code (Instance) so callers can name the rule the human overrode. */
export async function recordRuleOverride(
  ctx: OrgCtx,
  ruleCode: string,
): Promise<{ confidence: number; underReview: boolean } | null> {
  const rule = await db(ctx).platLearningRule.findFirst({
    where: { orgId: ctx.orgId, ruleCode },
  });
  if (!rule) return null;
  const confidence = Math.max(0, rule.confidence - RULE_OVERRIDE_DECAY);
  const underReview = confidence <= RULE_UNDER_REVIEW_AT;
  await db(ctx).platLearningRule.update({
    where: { id: rule.id },
    data: {
      confidence,
      ...(underReview ? { isActive: false, notes: "Under Review — confidence decayed to 50 or below" } : {}),
    },
  });
  return { confidence, underReview };
}

/** Best-effort ladder persistence (Override_Level + Application_Window are
 *  schema-drift-provisioned columns) — an unmigrated base silently keeps
 *  legacy behaviour; a failed ladder write never fails the triggering event. */
async function writeRuleLadder(
  ctx: OrgCtx,
  ruleId: string,
  state: { window: boolean[]; level: OverrideLevel; demoted: boolean },
): Promise<void> {
  try {
    const id = Number(ruleId);
    if (!Number.isInteger(id)) return;
    await db(ctx).platLearningRule.update({
      where: { id },
      data: {
        applicationWindow: serializeApplicationWindow(state.window),
        ...(state.demoted ? { overrideLevel: state.level } : {}),
      },
    });
  } catch {
    /* ladder columns absent (pre-migration base) — legacy behaviour stands */
  }
}

/** Set a rule's governance level explicitly (owner action in the learning UI,
 *  or the Owner_Only stamp on newly created rules). Best-effort, like the
 *  ladder writes. */
export async function setRuleOverrideLevel(
  ctx: OrgCtx,
  ruleId: string,
  level: OverrideLevel,
): Promise<void> {
  try {
    const id = Number(ruleId);
    if (!Number.isInteger(id)) return;
    await db(ctx).platLearningRule.update({ where: { id }, data: { overrideLevel: level } });
  } catch {
    /* column absent (pre-migration base) */
  }
}

/** Targeted rule-firing bookkeeping for the cascade engine: bump exactly ONE
 *  rule by code (Times_Triggered/Last_Triggered/confidence+1/ladder), without
 *  applyRules' context matching — an empty Trigger_Context matches everything
 *  there, which would fire unrelated rules. Dual-store (cascade engine runs on
 *  both since migration-plan Phase 3; PG has no Last_Triggered column). */
export async function markRuleApplied(ctx: OrgCtx, rule: RuleRow): Promise<void> {
  const id = Number(rule.id);
  if (!Number.isInteger(id)) return;
  await db(ctx).platLearningRule.update({
    where: { id },
    data: {
      timesTriggered: rule.timesTriggered + 1,
      confidence: Math.min(RULE_CONFIDENCE_MAX, rule.confidence + 1),
    },
  });
  await writeRuleLadder(ctx, rule.id, ladderAfterEvent(rule.overrideLevel, rule.applicationWindow, true));
}

/** Working-memory hydration: the org's rules as a prompt block for the
 *  assistant. Spec 12 session protocol: Active rules by Priority descending
 *  (getActiveRules), each with its trigger context and override posture, up to
 *  the 80-rule review flag. */
export async function learningPromptText(ctx: OrgCtx): Promise<string> {
  const rules = await getActiveRules(ctx);
  if (!rules.length) return "";
  const locked = rules.filter((r) => r.cannotOverride);
  const rest = rules.filter((r) => !r.cannotOverride).slice(0, 80);
  const fmt = (r: (typeof rules)[number]) => {
    const trigger = Object.entries(parseContext(r.triggerCondition))
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    return `- [${r.ruleCode} · conf ${r.confidence} · priority ${r.priority}] ${r.description}${trigger ? ` (applies when ${trigger})` : ""}`;
  };
  const parts: string[] = [];
  if (locked.length) {
    parts.push(`CRITICAL RULES (must never be overridden):\n${locked.map(fmt).join("\n")}`);
  }
  if (rest.length) {
    parts.push(
      `Validated learning rules for this customer (apply where relevant):\n${rest.map(fmt).join("\n")}`,
    );
  }
  if (rules.length > 80) {
    parts.push(`(NOTE: ${rules.length} active rules exceeds the 80-rule review threshold — flag for owner review.)`);
  }
  return parts.join("\n\n");
}

// ── Contextual Intelligence snapshot ────────────────────────────────

/** Corrections with a variance, from the active backend. */
async function snapshotCorrections(ctx: OrgCtx): Promise<{ variancePct: number | null }[]> {
  return db(ctx).platCorrection.findMany({
    where: { orgId: ctx.orgId, variancePct: { not: null } },
    select: { variancePct: true },
  });
}

/** Count of pending hypotheses, from the active backend. */
async function snapshotPendingHyp(ctx: OrgCtx): Promise<number> {
  return db(ctx).platHypothesis.count({ where: { orgId: ctx.orgId, status: "pending" } });
}

/** Total + completed job counts from the active backend. */
async function snapshotJobCounts(ctx: OrgCtx): Promise<{ total: number; completed: number }> {
  const [total, completed] = await Promise.all([
    db(ctx).platJob.count({ where: { orgId: ctx.orgId } }),
    db(ctx).platJob.count({ where: { orgId: ctx.orgId, status: { in: ["completed", "archived"] } } }),
  ]);
  return { total, completed };
}

/** Average confidence of the most recent snapshot (for the trajectory delta). */
async function snapshotPrevAvg(ctx: OrgCtx): Promise<number | null> {
  const prev = await db(ctx).platIntelligenceSnapshot.findFirst({
    where: { orgId: ctx.orgId },
    orderBy: { capturedAt: "desc" },
  });
  return prev?.avgConfidence ?? null;
}

export async function snapshotIntelligence(ctx: OrgCtx): Promise<number> {
  const [counts, rules, corrections, pendingHyp, prevAvg] = await Promise.all([
    snapshotJobCounts(ctx),
    getActiveRules(ctx),
    snapshotCorrections(ctx),
    snapshotPendingHyp(ctx),
    snapshotPrevAvg(ctx),
  ]);
  const { total: totalJobs, completed: completedJobs } = counts;

  const accuracy = corrections.length
    ? Math.round(
        (100 -
          corrections.reduce((s, c) => s + Math.abs(c.variancePct ?? 0), 0) / corrections.length) *
          10,
      ) / 10
    : null;
  const avgConfidence = rules.length
    ? Math.round((rules.reduce((s, r) => s + r.confidence, 0) / rules.length) * 10) / 10
    : 0;
  const autoApplyRules = rules.filter((r) => r.autoApply).length;

  const gaps: string[] = [];
  if (corrections.length === 0) gaps.push("No corrections recorded — the learning loop has no episodic input yet.");
  if (pendingHyp > 0) gaps.push(`${pendingHyp} hypotheses awaiting human review.`);
  if (!rules.length) gaps.push("No active learning rules yet — corrections not yet promoted.");
  if (autoApplyRules === 0 && rules.length > 0) gaps.push("No rules at auto-apply threshold yet.");

  let trajectory = "stable";
  if (prevAvg != null) {
    const delta = avgConfidence - prevAvg;
    if (delta > 2) trajectory = "improving";
    else if (delta < -2) trajectory = "degrading";
  }

  const topRules = rules.slice(0, 5).map((r) => ({
    code: r.ruleCode,
    confidence: r.confidence,
    triggers: r.timesTriggered,
    desc: r.description,
  }));

  const snap = await db(ctx).platIntelligenceSnapshot.create({
    data: {
      orgId: ctx.orgId,
      totalJobs,
      completedJobs,
      accuracyRatePct: accuracy,
      activeRules: rules.length,
      autoApplyRules,
      avgConfidence,
      topRules: JSON.stringify(topRules),
      gaps: JSON.stringify(gaps),
      metrics: JSON.stringify({ trajectory, corrections: corrections.length }),
    },
  });
  return snap.id;
}
