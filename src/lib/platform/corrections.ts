// Correction event emitter (Platform Architecture doc utility layer).
// Called by any service when a human overrides an AI output, so corrections
// are captured consistently regardless of which module produced the value.
// The hypothesis engine (services/platform/learning) clusters these later.
//
// Spec 12 Module 6 Stage 1 (Capture): every correction carries a Source_Module
// (which module produced the corrected value), one of the five Root_Cause
// categories, and a Correction_Direction. The Airtable CORRECTIONS table
// predates those columns, so Root_Cause holds the category (the clusterable
// value), Description holds the free-text detail, and sourceModule/direction
// ride in the Notes JSON until the template gains dedicated fields.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { recordRuleOverride } from "@/services/platform/learning";
import { Actor, OrgCtx } from "./types";
import type { RecordId } from "./recordWriter";

/** Spec 12 Module 6 Root_Cause categories. A Scope Change correction does not
 *  update the estimation model; a Model Error correction does. Both still feed
 *  HYPOTHESES. Domain subcategories belong in the free-text detail note. */
export const CORRECTION_ROOT_CAUSES = [
  "Estimation Error",
  "Data Quality",
  "Scope Change",
  "External Factor",
  "Model Error",
] as const;
export type CorrectionRootCause = (typeof CORRECTION_ROOT_CAUSES)[number];

export type CorrectionSourceModule = "module2" | "module3" | "module5" | "module6" | "manual";

export type CorrectionDirection =
  | "Over_Estimate"
  | "Under_Estimate"
  | "Wrong_Category"
  | "Wrong_Sequence";

/** Context keys starting with "_" are reserved for loop metadata (source
 *  module, direction, detail note) and are never used as trigger keys. */
export const RESERVED_CONTEXT_PREFIX = "_";

export interface CorrectionInput {
  jobId?: number;
  /** What kind of record was corrected, e.g. "budget_line", "variation_order". */
  entityType: string;
  entityId?: number;
  /** Dotted dimension key, e.g. "budget.concrete", "variation.cost_impact". */
  dimension: string;
  aiValue?: number;
  humanValue?: number;
  aiValueText?: string;
  humanValueText?: string;
  /** Which module produced the value that was corrected (Spec 12 Stage 1). */
  sourceModule: CorrectionSourceModule;
  /** One of the five Spec 12 Root_Cause categories — the clusterable cause. */
  rootCauseCategory: CorrectionRootCause;
  /** Required free-text detail — corrections without a stated cause can't be
   *  reviewed. Stored as the correction description, not the cluster key. */
  rootCause: string;
  /** Derived from the variance sign when omitted and the values are numeric. */
  direction?: CorrectionDirection;
  /** Supplier anchor (ORGANISATIONS name/id) — clusters supplier patterns. */
  supplier?: string;
  /** Phase anchor — clusters phase-scoped patterns. */
  phase?: string;
  /** Arbitrary trigger keys for clustering, e.g. { suburb: "Dulong" }. */
  context?: Record<string, string>;
  /** LEARNING_RULES codes (Instance) this correction overrides — each takes
   *  the Spec 12 confidence decay (−5; ≤50 → Under Review). */
  overriddenRuleCodes?: string[];
}

export async function emitCorrection(
  ctx: OrgCtx,
  actor: Actor,
  input: CorrectionInput,
): Promise<RecordId> {
  const variancePct =
    input.aiValue != null && input.humanValue != null && input.aiValue !== 0
      ? Math.round(((input.humanValue - input.aiValue) / Math.abs(input.aiValue)) * 1000) / 10
      : null;

  // Positive variance = the human's value was higher = the AI under-estimated.
  const direction: CorrectionDirection | undefined =
    input.direction ??
    (variancePct != null ? (variancePct > 0 ? "Under_Estimate" : "Over_Estimate") : undefined);

  // Trigger context: caller keys plus the supplier/phase anchors (plain keys —
  // they participate in rule triggers) and reserved loop metadata (_-prefixed,
  // stripped from trigger derivation by the hypothesis engine).
  const context: Record<string, string> = {
    ...(input.context ?? {}),
    ...(input.supplier ? { supplier: input.supplier } : {}),
    ...(input.phase ? { phase: input.phase } : {}),
    _sourceModule: input.sourceModule,
    ...(direction ? { _direction: direction } : {}),
  };

  // Airtable system of record: Root_Cause carries the category (the value the
  // hypothesis engine clusters on, per Spec 12 Stage 2), Description carries
  // the human-readable detail; app-only columns ride in Notes JSON; the
  // Hypothesis link is set later by runHypothesisEngine. The execution-log
  // audit stays Postgres (best effort).
  let correctionId: RecordId;
  if (airtableEnabled(ctx)) {
    const rec = await core.create(ctx.orgSlug, "CORRECTIONS", {
      Field_Corrected: input.dimension,
      Root_Cause: input.rootCauseCategory,
      Description: input.rootCause.trim(),
      Variance_Percent: variancePct ?? undefined,
      AI_Output: input.aiValueText || (input.aiValue != null ? String(input.aiValue) : ""),
      Human_Correction:
        input.humanValueText || (input.humanValue != null ? String(input.humanValue) : ""),
      Corrected_By: actor.name,
      Rule_Generated: false,
      // Session-protocol anchor: "corrections since the last session" counts on
      // this date (the canonical column pre-exists; createdTime isn't exposed).
      Date_Found: new Date().toISOString().slice(0, 10),
      Notes: JSON.stringify({
        jobId: input.jobId,
        entityType: input.entityType,
        entityId: input.entityId,
        sourceModule: input.sourceModule,
        direction,
        rootCauseDetail: input.rootCause.trim(),
        context,
      }),
    });
    correctionId = rec.id;
    // Spec 12 first-class columns (lock plan §6.4): Source_Module and
    // Correction_Direction are schema-drift-provisioned — written as a
    // separate best-effort update so an unmigrated base still gets the
    // correction (the values also ride in Notes JSON for legacy reads).
    await core
      .update(ctx.orgSlug, "CORRECTIONS", rec.id, {
        Source_Module: input.sourceModule,
        ...(direction ? { Correction_Direction: direction } : {}),
      })
      .catch(() => {});
  } else {
    const correction = await db(ctx).platCorrection.create({
      data: {
        orgId: ctx.orgId,
        jobId: input.jobId,
        entityType: input.entityType,
        entityId: input.entityId,
        dimension: input.dimension,
        aiValue: input.aiValue,
        humanValue: input.humanValue,
        aiValueText: input.aiValueText ?? "",
        humanValueText: input.humanValueText ?? "",
        variancePct,
        rootCause: input.rootCauseCategory,
        context: JSON.stringify({ ...context, _note: input.rootCause.trim() }),
        correctedBy: actor.name,
      },
    });
    correctionId = correction.id;
  }

  // Spec 12 Override_Permission governance: a correction that overrides a rule
  // decays that rule's confidence. Best effort — a failed decay must not lose
  // the correction.
  for (const ruleCode of input.overriddenRuleCodes ?? []) {
    await recordRuleOverride(ctx, ruleCode).catch(() => {});
  }

  const auditPayload = JSON.stringify({
    dimension: input.dimension,
    aiValue: input.aiValue,
    humanValue: input.humanValue,
    rootCause: `${input.rootCauseCategory}: ${input.rootCause}`,
    sourceModule: input.sourceModule,
    direction,
  });
  // Audit failure must not lose the correction. Airtable mode audits into the
  // org base's EXECUTION_LOG (Postgres may not exist at all in that world).
  if (airtableEnabled(ctx)) {
    await core
      .create(ctx.orgSlug, "EXECUTION_LOG", {
        Log_Entry: `correction ${input.dimension}`.slice(0, 200),
        Action_Type: "Create",
        Tables_Affected: "CORRECTIONS",
        Summary: auditPayload,
        Initiated_By: actor.type === "ai" ? "AI" : actor.type === "human" ? "Owner" : "System",
        Status: "Done",
        Date_Time: new Date().toISOString(),
      })
      .catch(() => {});
  } else {
    await db(ctx).platExecutionLog
      .create({
        data: {
          orgId: ctx.orgId,
          jobId: input.jobId,
          actorType: actor.type,
          actorName: actor.name,
          operation: "create",
          targetTable: "plat_core_correction",
          targetId: typeof correctionId === "number" ? correctionId : null,
          result: "",
          payload: auditPayload,
          status: "executed",
          executedAt: new Date(),
          sourceMessageId: actor.sourceMessageId,
        },
      })
      .catch(() => {});
  }

  return correctionId;
}

/** Compare an AI-produced object against the human-edited version and return
 *  one CorrectionInput per changed numeric dimension — so every
 *  approve-with-edits flow emits corrections without bespoke code. */
export function diffForCorrections(
  aiObj: Record<string, unknown>,
  humanObj: Record<string, unknown>,
  dimensions: { field: string; dimension: string }[],
  base: Pick<
    CorrectionInput,
    | "entityType"
    | "entityId"
    | "jobId"
    | "rootCause"
    | "rootCauseCategory"
    | "sourceModule"
    | "supplier"
    | "phase"
    | "context"
  >,
): CorrectionInput[] {
  const out: CorrectionInput[] = [];
  for (const { field, dimension } of dimensions) {
    const ai = Number(aiObj[field]);
    const human = Number(humanObj[field]);
    if (!Number.isFinite(ai) || !Number.isFinite(human) || ai === human) continue;
    out.push({ ...base, dimension, aiValue: ai, humanValue: human });
  }
  return out;
}
