import { db, prisma } from "@/lib/db";
import { scopeByJob } from "./rls";
import {
  PriorityBand,
  priorityBandForActionDueDate,
  priorityBandForRiskScore,
  strongerBand,
} from "./projectIntelligence";
import type { OrgCtx } from "./types";

export interface ProjectPlanActionView {
  id: string;
  title: string;
  owner: string;
  dueDate: Date | null;
  status: string;
}

export interface ProjectPlanWorkstreamView {
  id: string;
  jobId: string | null;
  name: string;
  status: string;
  description: string;
  milestone: string;
  lastUpdated: Date | null;
  jobCode: string;
  priority: PriorityBand;
  attentionReason: string;
  actions: ProjectPlanActionView[];
}

async function fromPostgres(ctx: OrgCtx): Promise<ProjectPlanWorkstreamView[]> {
  const [workstreams, risks] = await Promise.all([
    db(ctx).platWorkstream.findMany({
      where: { orgId: ctx.orgId },
      orderBy: { lastUpdated: "desc" },
      include: {
        job: { select: { id: true, code: true } },
        actions: { orderBy: { dueDate: "asc" }, take: 10 },
      },
    }),
    db(ctx).platConRisk.findMany({
      where: { orgId: ctx.orgId, status: { in: ["open", "accepted"] } },
      select: { jobId: true, likelihood: true, impact: true },
    }),
  ]);
  const riskByJob = new Map<number, number>();
  for (const risk of risks) {
    if (risk.jobId == null) continue;
    const score = Number(risk.likelihood) * Number(risk.impact);
    const current = riskByJob.get(risk.jobId) ?? 0;
    riskByJob.set(risk.jobId, Math.max(current, score));
  }
  return workstreams.map((ws) => ({
    ...(() => {
      let priority: PriorityBand = "LOW";
      let reason = "";
      for (const action of ws.actions) {
        if (action.status === "done" || action.status === "closed" || action.status === "deferred") continue;
        const band = priorityBandForActionDueDate(action.dueDate);
        if (band !== "LOW" && !reason) reason = "Action due date pressure";
        priority = strongerBand(priority, band);
      }
      const riskScore = ws.job?.id ? riskByJob.get(ws.job.id) ?? 0 : 0;
      if (riskScore > 0) {
        const riskBand = priorityBandForRiskScore(riskScore);
        if (!reason && riskBand !== "LOW") reason = `Risk exposure (${riskScore})`;
        priority = strongerBand(priority, riskBand);
      }
      return { priority, attentionReason: reason };
    })(),
    id: String(ws.id),
    jobId: ws.job ? String(ws.job.id) : null,
    name: ws.name,
    status: ws.status,
    description: ws.description,
    milestone: ws.milestone,
    lastUpdated: ws.lastUpdated,
    jobCode: ws.job?.code ?? "",
    actions: ws.actions.map((a) => ({
      id: String(a.id),
      title: a.title,
      owner: a.owner,
      dueDate: a.dueDate,
      status: a.status,
    })),
  }));
}

export async function loadProjectPlan(ctx: OrgCtx): Promise<ProjectPlanWorkstreamView[]> {
  const rows = await fromPostgres(ctx);
  return scopeByJob(ctx, rows, (r) => r.jobId);
}
