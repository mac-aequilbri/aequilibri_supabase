// Deterministic cascade engine — Spec 12 Module 5's seven cascading update
// rules, run as the third post-write hook at the recordWriter choke point
// (after reconciliation and outbound events; docs/spec12-lock-plan.md §5.1).
//
// Two effect classes, matching the spec's own split:
//  · WRITE effects (rules D/F/G — "create/update/escalate"): executed as
//    direct system writes through writeRecord. The owner pre-approves the RULE
//    (each rule is a LEARNING_RULES record they activate/deactivate in the
//    learning UI); per-firing approval would recreate the manual toil the rule
//    exists to remove. Every firing is EXECUTION_LOG-audited by writeRecord
//    itself and bumps the rule's Times_Triggered/confidence.
//  · ADVISORY effects (rules A/B/C/E — "review X for downstream impact"): no
//    writes. A lightweight EXECUTION_LOG advisory row (Status "Ongoing") is
//    surfaced in the coordination queue until dismissed. Dismissing as "not
//    relevant" counts as a rule override: confidence decays and a Module 5
//    CORRECTIONS record is captured — closing Module 6's capture class (c).
//
// Posture and guards:
//  · Dual-store (migration-plan Phase 3): rule bodies and advisories read and
//    write whichever backend the org is on — Airtable rec… ids or Postgres
//    numeric ids. Advisories live in EXECUTION_LOG on both stores.
//  · Cascades fire on human and AI-approved writes; system writes are skipped,
//    which also makes cascade-on-cascade recursion impossible.
//  · Rules fire only when an ACTIVE LEARNING_RULES record with the matching
//    CASCADE-x code exists (seeded at onboarding / via the learning UI) — the
//    owner's on/off switch. A write-effect rule demoted to Advisory (governance
//    ladder) degrades to an advisory surfacing instead of writing.
//  · Every rule body is try/caught: a cascade failure never fails the primary
//    write, and one rule's failure never blocks another's.
//  · Effects fire only on app-mediated writes — direct Airtable-UI edits
//    bypass them (same accepted limitation as post-write reconciliation).

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getActiveRules, markRuleApplied, type RuleRow } from "@/services/platform/learning";
import { normalizeRag } from "./phasesSource";
import type { Actor, OrgCtx } from "./types";

const S = (v: unknown): string => (typeof v === "string" ? v : "");
const N = (v: unknown): number => (typeof v === "number" ? v : Number(v) || 0);
const firstLink = (v: unknown): string | null =>
  Array.isArray(v) && v.length > 0 ? String(v[0]) : null;

/** What the engine sees of a completed write. `data` carries APP payload keys
 *  (jobId/status/…) — the same keys the field maps translate. */
export interface CascadeWrite {
  table: string;
  op: "create" | "update" | "delete";
  data: Record<string, unknown>;
  actor: Actor;
  recordId: string | number | undefined;
}

interface CascadeRule {
  /** Stable LEARNING_RULES Instance code the owner toggles. */
  code: string;
  kind: "write" | "advisory";
  /** recordWriter table key this rule watches. */
  watch: string;
  /** Fires when the completed write's payload matches. */
  trigger: (data: Record<string, unknown>, op: CascadeWrite["op"]) => boolean;
  /** Advisory message / write-effect description (also the seeded directive). */
  message: string;
  /** Write effects only — the system write(s) to perform. */
  execute?: (ctx: OrgCtx, write: CascadeWrite) => Promise<void>;
}

const CASCADE_ACTOR: Actor = { type: "system", name: "Cascade engine" };

const has = (data: Record<string, unknown>, key: string): boolean =>
  key in data && data[key] !== undefined && data[key] !== "";

// ── The seven rules (Spec 12 Module 5 "Cascading update rules") ─────────────

export const CASCADE_RULES: CascadeRule[] = [
  {
    code: "CASCADE-A",
    kind: "advisory",
    watch: "phase",
    trigger: (d) => has(d, "status"),
    message:
      "Phase status changed — review BUDGET, PLAN, ISSUES and PROCUREMENT for downstream impact.",
  },
  {
    code: "CASCADE-B",
    kind: "advisory",
    watch: "vendor",
    trigger: () => true,
    message:
      "Vendor record changed — review linked PLAN tasks, ISSUES, PROCUREMENT orders and CASHFLOWS for affected records.",
  },
  {
    code: "CASCADE-C",
    kind: "advisory",
    watch: "budget_line",
    trigger: (d) => has(d, "forecast") || has(d, "budgetAmount"),
    message: "Budget line changed — reconcile CASHFLOWS period forecasts.",
  },
  {
    code: "CASCADE-D",
    kind: "write",
    watch: "procurement",
    trigger: (d) => ["invoiced", "paid"].includes(S(d.status).toLowerCase()),
    message:
      "Procurement moved to Invoiced/Paid — create or update the corresponding outgoing CASHFLOWS entry.",
    execute: cascadeProcurementToCashflow,
  },
  {
    code: "CASCADE-E",
    kind: "advisory",
    watch: "procurement",
    trigger: (d, op) => op === "update" && has(d, "dueDate"),
    message:
      "Procurement expected date changed — review the linked PLAN task; a predecessor dependency may shift.",
  },
  {
    code: "CASCADE-F",
    kind: "write",
    watch: "action",
    trigger: (d) => S(d.issueType) === "Blocker",
    message: "Blocker issue raised — escalate the linked phase's RAG to Amber minimum.",
    execute: cascadeBlockerToPhaseRag,
  },
  {
    code: "CASCADE-G",
    kind: "write",
    watch: "risk",
    trigger: (d) => S(d.status).toLowerCase() === "materialised",
    message: "Risk materialised — create the linked ISSUES record automatically.",
    execute: cascadeRiskToIssue,
  },
];

/** Seeds for the 7 rules as LEARNING_RULES records. Advisory rules seed Active
 *  (informational, no writes); write-effect rules seed as Drafts the owner
 *  activates in the learning UI — the propose-before-write culture applied to
 *  standing automation (lock decision D-4). */
export const CASCADE_RULE_SEEDS = CASCADE_RULES.map((r) => ({
  ruleCode: r.code,
  description: `[Cascade ${r.kind}] ${r.message}`,
  triggerCondition: JSON.stringify({ cascade: r.code }),
  isActive: r.kind === "advisory",
}));

// ── Engine ──────────────────────────────────────────────────────────────────

/** Run the cascade rules for a completed write. Never throws; never fails the
 *  primary write. Wired into writeRecord + executeProposal (recordWriter). */
export async function runCascades(ctx: OrgCtx, write: CascadeWrite): Promise<void> {
  try {
    if (write.actor.type === "system") return; // no cascade-on-cascade
    if (write.op === "delete") return;
    const matches = CASCADE_RULES.filter(
      (r) => r.watch === write.table && r.trigger(write.data, write.op),
    );
    if (!matches.length) return;

    // The owner's switchboard: a rule fires only when its ACTIVE LEARNING_RULES
    // record exists. getActiveRules is TTL-cached at the Airtable read layer.
    const active = new Map<string, RuleRow>(
      (await getActiveRules(ctx))
        .filter((r) => r.ruleCode.startsWith("CASCADE-"))
        .map((r) => [r.ruleCode, r]),
    );

    for (const rule of matches) {
      const record = active.get(rule.code);
      if (!record) continue; // not seeded / deactivated / draft — off
      try {
        if (rule.kind === "write" && rule.execute && record.overrideLevel !== "advisory") {
          await rule.execute(ctx, write);
        } else {
          await recordAdvisory(ctx, rule, write);
        }
        await markRuleApplied(ctx, record).catch(() => {});
      } catch (err) {
        logger.warn("Cascade rule failed", {
          orgId: ctx.orgId,
          rule: rule.code,
          table: write.table,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    logger.warn("Cascade engine failed", {
      orgId: ctx.orgId,
      table: write.table,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ── Write effects ───────────────────────────────────────────────────────────

/** Rule D — PROCUREMENT → Invoiced/Paid ⇒ upsert the outgoing CASHFLOWS txn.
 *  Idempotent: the txn carries a `cascade:<procurement id>` marker in Notes;
 *  a repeat firing updates it instead of stacking duplicates. */
async function cascadeProcurementToCashflow(ctx: OrgCtx, write: CascadeWrite): Promise<void> {
  const status = S(write.data.status).toLowerCase() === "paid" ? "Paid" : "Confirmed";
  const { writeRecord } = await import("./recordWriter");

  // Resolve the procurement + existing marker txn on whichever store the org
  // uses; the upsert below goes through writeRecord identically.
  let source: {
    marker: string;
    name: string;
    amount: number;
    period: string;
    jobId: string | number | null;
    existingId: string | number | null;
  } | null = null;

  if (airtableEnabled(ctx)) {
    const procId = typeof write.recordId === "string" ? write.recordId : null;
    if (!procId?.startsWith("rec")) return;
    const proc = await core.get(ctx.orgSlug, "PROCUREMENT", procId);
    if (!proc) return;
    const marker = `cascade:${procId}`;
    const dateRaw = S(proc["Actual_Date"]) || S(proc["Expected_Date"]) || new Date().toISOString();
    const existing = await core.list(ctx.orgSlug, "CASHFLOWS", {
      maxRecords: 5,
      filterByFormula: `SEARCH("${marker.replace(/"/g, "")}", {Notes}&"")`,
    });
    source = {
      marker,
      name: `Procurement — ${S(proc["Procurement_Name"]) || "item"}`,
      amount: N(proc["Total_Cost"]) || N(proc["Quantity"]) * N(proc["Unit_Cost"]),
      period: dateRaw.slice(0, 7),
      jobId: firstLink(proc["Job"]),
      existingId: existing.length > 0 ? existing[0].id : null,
    };
  } else {
    const procId = Number(write.recordId);
    if (!Number.isInteger(procId)) return;
    const proc = await db(ctx).platConProcurement.findFirst({
      where: { id: procId, orgId: ctx.orgId },
    });
    if (!proc) return;
    const marker = `cascade:${procId}`;
    const dateRaw = (proc.dueDate ?? new Date()).toISOString();
    const existing = await db(ctx).platConCashflowLedger.findFirst({
      where: { orgId: ctx.orgId, notes: { contains: marker } },
    });
    source = {
      marker,
      name: `Procurement — ${proc.item || "item"}`,
      amount: N(proc.total) || N(proc.qty) * N(proc.unitPrice),
      period: dateRaw.slice(0, 7),
      jobId: proc.jobId,
      existingId: existing?.id ?? null,
    };
  }

  if (source.existingId != null) {
    await writeRecord(ctx, {
      table: "cashflow",
      op: "update",
      recordId: source.existingId,
      data: { period: source.period, amount: source.amount, status },
      actor: CASCADE_ACTOR,
    });
  } else {
    await writeRecord(ctx, {
      table: "cashflow",
      op: "create",
      data: {
        name: source.name,
        period: source.period,
        type: "Out",
        amount: source.amount,
        sourceOrPayee: "",
        category: "Procurement",
        status,
        notes: `Auto-created by ${source.marker} (CASCADE-D). Do not remove the marker.`,
        ...(source.jobId != null ? { jobId: source.jobId } : {}),
      },
      actor: CASCADE_ACTOR,
    });
  }
}

/** Rule F — a Blocker issue floors its linked phase's RAG at Amber (never
 *  lowers a Red). The canonical ISSUES table has no Phase link, so the phase
 *  can only come from the write payload (actionSchema.phaseId — the assistant
 *  and future forms pass it; without it the rule is a no-op by design). */
async function cascadeBlockerToPhaseRag(ctx: OrgCtx, write: CascadeWrite): Promise<void> {
  let phaseId: string | number | null = null;
  let currentRag = "";

  if (airtableEnabled(ctx)) {
    const recId = typeof write.data.phaseId === "string" ? write.data.phaseId : null;
    if (!recId?.startsWith("rec")) return;
    const phase = await core.get(ctx.orgSlug, "PHASES", recId);
    if (!phase) return;
    phaseId = recId;
    currentRag = normalizeRag(phase["RAG"]);
  } else {
    const numId = Number(write.data.phaseId);
    if (!Number.isInteger(numId) || numId <= 0) return;
    const phase = await db(ctx).platConPhase.findFirst({ where: { id: numId, orgId: ctx.orgId } });
    if (!phase) return;
    phaseId = numId;
    currentRag = normalizeRag(phase.rag);
  }
  if (currentRag === "Red" || currentRag === "Amber") return; // already at/above the floor

  const { writeRecord } = await import("./recordWriter");
  await writeRecord(ctx, {
    table: "phase",
    op: "update",
    recordId: phaseId,
    data: { rag: "Amber" },
    actor: CASCADE_ACTOR,
  });
}

/** Rule G — RISKS → Materialised ⇒ create the linked ISSUES record. Idempotent
 *  via the sourceType/sourceId provenance keys on ISSUES. */
async function cascadeRiskToIssue(ctx: OrgCtx, write: CascadeWrite): Promise<void> {
  let riskId: string | number | null = null;
  let riskTitle = "";
  let mitigation = "";
  let jobId: string | number | null = null;
  let already = false;

  if (airtableEnabled(ctx)) {
    const recId = typeof write.recordId === "string" ? write.recordId : null;
    if (!recId?.startsWith("rec")) return;
    const risk = await core.get(ctx.orgSlug, "RISKS", recId);
    if (!risk) return;
    // Idempotent on the ISSUES.RISKS link the action field map writes from riskId.
    const issues = await core.list(ctx.orgSlug, "ISSUES", { maxRecords: 1000 });
    already = issues.some(
      (i) => S(i["Issue_Type"]) === "Risk Materialised" && firstLink(i["RISKS"]) === recId,
    );
    riskId = recId;
    riskTitle = S(risk["Risk"]);
    mitigation = S(risk["Mitigation"]);
    jobId = firstLink(risk["Job"]);
  } else {
    const numId = Number(write.recordId);
    if (!Number.isInteger(numId)) return;
    const risk = await db(ctx).platConRisk.findFirst({ where: { id: numId, orgId: ctx.orgId } });
    if (!risk) return;
    already =
      (await db(ctx).platActionHub.findFirst({
        where: { orgId: ctx.orgId, issueType: "Risk Materialised", riskId: numId },
      })) !== null;
    riskId = numId;
    riskTitle = risk.description;
    mitigation = risk.mitigation;
    jobId = risk.jobId;
  }
  if (already) return;

  const { writeRecord } = await import("./recordWriter");
  await writeRecord(ctx, {
    table: "action",
    op: "create",
    data: {
      title: `Risk materialised: ${riskTitle || "(risk)"}`.slice(0, 300),
      detail: mitigation ? `Planned mitigation: ${mitigation}` : "",
      priority: "P1",
      issueType: "Risk Materialised",
      riskId,
      sourceType: "cascade",
      ...(jobId != null ? { jobId } : {}),
    },
    actor: CASCADE_ACTOR,
  });
}

// ── Advisories ──────────────────────────────────────────────────────────────

export interface CascadeAdvisory {
  /** EXECUTION_LOG record id — the dismiss target. */
  id: string;
  ruleCode: string;
  message: string;
  table: string;
  createdAt: string;
}

/** Persist an advisory as an EXECUTION_LOG row (Status "Ongoing"); the
 *  coordination queue surfaces it until dismissed. Dual-store: the same
 *  {cascade:{…}} JSON payload lands in Summary (Airtable) / payload (PG). */
async function recordAdvisory(ctx: OrgCtx, rule: CascadeRule, write: CascadeWrite): Promise<void> {
  const cascadeJson = JSON.stringify({
    cascade: {
      ruleCode: rule.code,
      message: rule.message,
      table: write.table,
      recordId: write.recordId == null ? null : String(write.recordId),
    },
  });
  if (airtableEnabled(ctx)) {
    await core.create(ctx.orgSlug, "EXECUTION_LOG", {
      Log_Entry: `Cascade advisory ${rule.code}`.slice(0, 200),
      Action_Type: "Update",
      Tables_Affected: write.table,
      Summary: cascadeJson,
      Initiated_By: "System",
      Status: "Ongoing",
      Date_Time: new Date().toISOString(),
    });
    return;
  }
  await db(ctx).platExecutionLog.create({
    data: {
      orgId: ctx.orgId,
      actorType: "system",
      actorName: "Cascade engine",
      operation: "cascade",
      targetTable: write.table,
      payload: cascadeJson,
      status: "Ongoing",
      executedAt: new Date(),
      result: rule.message,
    },
  });
}

/** Open advisories for the coordination queue, from whichever store holds
 *  EXECUTION_LOG. */
export async function loadCascadeAdvisories(ctx: OrgCtx): Promise<CascadeAdvisory[]> {
  if (!airtableEnabled(ctx)) {
    const rows = await db(ctx).platExecutionLog.findMany({
      where: { orgId: ctx.orgId, operation: "cascade", status: "Ongoing" },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    const out: CascadeAdvisory[] = [];
    for (const r of rows) {
      try {
        const c = (JSON.parse(r.payload) as { cascade?: { ruleCode?: string; message?: string; table?: string } }).cascade;
        if (!c?.ruleCode) continue;
        out.push({
          id: String(r.id),
          ruleCode: c.ruleCode,
          message: c.message ?? "",
          table: c.table ?? "",
          createdAt: r.createdAt.toISOString(),
        });
      } catch {
        /* not an advisory row */
      }
    }
    return out;
  }
  try {
    const rows = await core.list(ctx.orgSlug, "EXECUTION_LOG", { maxRecords: 100 });
    const out: CascadeAdvisory[] = [];
    for (const r of rows) {
      if (S(r["Status"]) !== "Ongoing") continue;
      try {
        const summary = JSON.parse(S(r["Summary"])) as {
          cascade?: { ruleCode?: string; message?: string; table?: string };
        };
        const c = summary.cascade;
        if (!c?.ruleCode) continue;
        out.push({
          id: r.id,
          ruleCode: c.ruleCode,
          message: c.message ?? "",
          table: c.table ?? "",
          createdAt: S(r["Date_Time"]),
        });
      } catch {
        /* not an advisory row */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Dismiss an advisory. `override` = "not relevant" — the rule fired wrongly:
 *  confidence decays (recordRuleOverride, incl. ladder demotion) and a Module 5
 *  CORRECTIONS record is captured (Module 6 capture class c). */
export async function dismissCascadeAdvisory(
  ctx: OrgCtx,
  advisoryId: string,
  actor: Actor,
  override: boolean,
): Promise<void> {
  let ruleCode = "";
  if (airtableEnabled(ctx)) {
    const row = await core.get(ctx.orgSlug, "EXECUTION_LOG", advisoryId);
    if (!row || S(row["Status"]) !== "Ongoing") return;
    try {
      ruleCode =
        (JSON.parse(S(row["Summary"])) as { cascade?: { ruleCode?: string } }).cascade?.ruleCode ?? "";
    } catch {
      return; // not an advisory row — refuse to touch other log entries
    }
    if (!ruleCode) return;
    await core.update(ctx.orgSlug, "EXECUTION_LOG", advisoryId, { Status: "Done" });
  } else {
    const numId = Number(advisoryId);
    if (!Number.isInteger(numId)) return;
    const row = await db(ctx).platExecutionLog.findFirst({
      where: { id: numId, orgId: ctx.orgId, operation: "cascade", status: "Ongoing" },
    });
    if (!row) return;
    try {
      ruleCode = (JSON.parse(row.payload) as { cascade?: { ruleCode?: string } }).cascade?.ruleCode ?? "";
    } catch {
      return; // not an advisory row — refuse to touch other log entries
    }
    if (!ruleCode) return;
    await db(ctx).platExecutionLog.update({ where: { id: numId }, data: { status: "Done" } });
  }
  if (override) {
    const { emitCorrection } = await import("./corrections");
    await emitCorrection(ctx, actor, {
      entityType: "cascade_advisory",
      dimension: `cascade.${ruleCode.toLowerCase()}`,
      aiValueText: "advisory raised",
      humanValueText: "dismissed as not relevant",
      sourceModule: "module5",
      rootCauseCategory: "Model Error",
      rootCause: `Cascade advisory ${ruleCode} dismissed as not relevant by ${actor.name}.`,
      overriddenRuleCodes: [ruleCode],
    }).catch(() => {});
  }
}

// ── Seeding ─────────────────────────────────────────────────────────────────

/** Idempotently seed the 7 cascade rules as LEARNING_RULES records (missing
 *  codes only). Used by onboarding and the learning-rules page's owner action
 *  (existing orgs predate the seeds). */
export async function seedCascadeRules(ctx: OrgCtx): Promise<number> {
  if (!airtableEnabled(ctx)) {
    const rows = await db(ctx).platLearningRule.findMany({
      where: { orgId: ctx.orgId, ruleCode: { startsWith: "CASCADE-" } },
      select: { ruleCode: true },
    });
    const existing = new Set(rows.map((r) => r.ruleCode));
    let created = 0;
    for (const seed of CASCADE_RULE_SEEDS) {
      if (existing.has(seed.ruleCode)) continue;
      await db(ctx).platLearningRule.create({
        data: {
          orgId: ctx.orgId,
          ruleCode: seed.ruleCode,
          kind: "guidance",
          description: seed.description,
          triggerCondition: seed.triggerCondition,
          confidence: 80,
          isActive: seed.isActive,
          autoApply: false,
          cannotOverride: false,
          overrideLevel: "owner_only",
          dateActivated: seed.isActive ? new Date() : null,
        },
      });
      created += 1;
    }
    return created;
  }
  const { airtableMapFor, toFields } = await import("@/lib/airtable/fieldMaps");
  const { setRuleOverrideLevel } = await import("@/services/platform/learning");
  const rows = await core.list(ctx.orgSlug, "LEARNING_RULES", { maxRecords: 500 });
  const existing = new Set(rows.map((r) => S(r["Instance"])));
  const map = airtableMapFor("learning_rule")!;
  let created = 0;
  for (const seed of CASCADE_RULE_SEEDS) {
    if (existing.has(seed.ruleCode)) continue;
    const rec = await core.create(
      ctx.orgSlug,
      map.table,
      toFields(
        map,
        {
          ruleCode: seed.ruleCode,
          kind: "guidance",
          description: seed.description,
          triggerCondition: seed.triggerCondition,
          confidence: 80,
          isActive: seed.isActive,
          autoApply: false,
          cannotOverride: false,
          dateIssued: new Date(),
        },
        "create",
      ),
    );
    await setRuleOverrideLevel(ctx, rec.id, "owner_only");
    created += 1;
  }
  return created;
}
