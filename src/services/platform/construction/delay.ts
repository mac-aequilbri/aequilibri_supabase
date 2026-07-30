// Delay cascade analysis — given a trigger event and delay days, model the
// knock-on impact across the job's remaining phases. Output is advisory
// (logged, not persisted as entities).

import { callClaude } from "@/lib/claude";
import { db, prisma } from "@/lib/db";
import { loadJobContext } from "@/lib/platform/jobContextSource";
import { modelFor } from "@/lib/platform/modelRouter";
import { getPrompt } from "@/lib/platform/prompts";
import { writeRecord } from "@/lib/platform/recordWriter";
import type { RecordId } from "@/lib/platform/recordWriter";
import type { OrgCtx } from "@/lib/platform/types";

export interface CascadeResult {
  impacts: { phase: string; delayDays: number; reason: string }[];
  totalDelayDays: number;
  mitigations: string[];
  demoMode: boolean;
}

export interface CascadeFollowUpResult {
  proposedActions: number;
  proposedRisks: number;
}

export async function analyzeDelayCascade(
  ctx: OrgCtx,
  userName: string,
  jobId: RecordId,
  trigger: string,
  delayDays: number,
): Promise<CascadeResult> {
  const job = await loadJobContext(ctx, jobId);
  if (!job) throw new Error("Job not found");
  const phases = job.phases.map((p) => ({ name: p.name, status: p.status, completionPct: p.completionPct }));

  const { system, version } = getPrompt("delay.cascade");
  const res = await callClaude(
    system,
    `Trigger: ${trigger}\nInitial delay: ${delayDays} days\nPhases (in order): ${JSON.stringify(phases)}`,
    { model: modelFor("complex_reasoning"), maxTokens: 1200 },
  );

  let result: CascadeResult;
  if (res.demo_mode) {
    const remaining = phases.filter((p) => p.status !== "complete");
    result = {
      impacts: remaining.map((p, i) => ({
        phase: p.name,
        delayDays: Math.max(1, delayDays - i),
        reason: "Demo mode — simulated sequential slip.",
      })),
      totalDelayDays: delayDays + Math.max(0, remaining.length - 1),
      mitigations: ["Demo mode — connect an API key for real analysis."],
      demoMode: true,
    };
  } else {
    try {
      const parsed = JSON.parse(res.content.replace(/^```(json)?|```$/g, "").trim());
      result = {
        impacts: Array.isArray(parsed.impacts)
          ? parsed.impacts.map((i: { phase?: unknown; delayDays?: unknown; reason?: unknown }) => ({
              phase: String(i.phase ?? ""),
              delayDays: Number(i.delayDays) || 0,
              reason: String(i.reason ?? ""),
            }))
          : [],
        totalDelayDays: Number(parsed.totalDelayDays) || delayDays,
        mitigations: Array.isArray(parsed.mitigations) ? parsed.mitigations.map(String) : [],
        demoMode: false,
      };
    } catch {
      result = {
        impacts: [],
        totalDelayDays: delayDays,
        mitigations: [`AI output could not be parsed: ${res.content.slice(0, 300)}`],
        demoMode: false,
      };
    }
  }

  await db(ctx).platExecutionLog
    .create({
      data: {
        orgId: ctx.orgId,
        jobId: typeof jobId === "number" ? jobId : null,
        actorType: "ai",
        actorName: "Delay Analyst",
        operation: "generate",
        targetTable: "delay_cascade",
        payload: JSON.stringify({ trigger, delayDays, by: userName }),
        result: JSON.stringify(result).slice(0, 4000),
        status: "executed",
        executedAt: new Date(),
        promptVersion: version,
      },
    })
    .catch(() => {});

  return result;
}

export async function proposeDelayCascadeFollowUps(
  ctx: OrgCtx,
  userName: string,
  jobId: RecordId,
  trigger: string,
  cascade: CascadeResult,
): Promise<CascadeFollowUpResult> {
  let proposedActions = 0;
  let proposedRisks = 0;
  const actor = { type: "human" as const, name: userName || "Coordinator" };

  const topImpacts = cascade.impacts
    .filter((impact) => impact.delayDays > 0)
    .sort((a, b) => b.delayDays - a.delayDays)
    .slice(0, 3);

  for (const impact of topImpacts) {
    const due = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const proposed = await writeRecord(ctx, {
      table: "action",
      op: "create",
      requireApproval: true,
      actor,
      data: {
        jobId,
        title: `Mitigate schedule slip in ${impact.phase}`,
        detail: `Triggered by "${trigger}". Predicted delay: ${impact.delayDays} day(s). Reason: ${impact.reason}`,
        owner: "Project Lead",
        dueDate: due,
        priority: impact.delayDays >= 10 ? "high" : "medium",
        sourceType: "manual",
        context: { module5: { trigger, cascade } },
      },
    });
    if (proposed.status === "proposed") proposedActions += 1;
  }

  if (cascade.totalDelayDays >= 10) {
    const proposed = await writeRecord(ctx, {
      table: "risk",
      op: "create",
      requireApproval: true,
      actor,
      data: {
        jobId,
        description: `Schedule cascade risk: ${trigger}`,
        likelihood: 4,
        impact: cascade.totalDelayDays >= 20 ? 5 : 4,
        mitigation: cascade.mitigations[0] || "Introduce staged recovery plan and resequence critical activities.",
        status: "open",
        owner: "Project Lead",
        sourceType: "manual",
      },
    });
    if (proposed.status === "proposed") proposedRisks += 1;
  }

  return { proposedActions, proposedRisks };
}
