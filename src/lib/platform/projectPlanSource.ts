import { airtableEnabled, core } from "@/lib/airtable";
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function dateOrNull(v: unknown): Date | null {
  const raw = str(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function linksTo(v: unknown, recordId: string): boolean {
  return Array.isArray(v) && v.some((x) => String(x) === recordId);
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

async function fromAirtable(ctx: OrgCtx): Promise<ProjectPlanWorkstreamView[]> {
  const [jobs, phases, actions, risks] = await Promise.all([
    core.list(ctx.orgSlug, "JOBS", { maxRecords: 500 }),
    core.list(ctx.orgSlug, "PHASES", { maxRecords: 1000 }),
    core.list(ctx.orgSlug, "ISSUES", { maxRecords: 500 }),
    core.list(ctx.orgSlug, "RISKS", { maxRecords: 500 }),
  ]);

  return jobs.map((j) => {
    const jobPhases = phases
      .filter((p) => linksTo(p["Job"], j.id))
      .sort((a, b) => Number(a["Sort_Order"] ?? 0) - Number(b["Sort_Order"] ?? 0));
    const nextPhase = jobPhases.find((p) => str(p["Status"]) !== "complete");

    const jobActions = actions
      .filter((a) => linksTo(a["Job"], j.id))
      .slice(0, 10)
      .map((a) => ({
        id: a.id,
        title: str(a["Action_Name"]) || "(action)",
        owner: str(a["Assigned_To"]),
        dueDate: dateOrNull(a["Due_Date"]),
        status: str(a["Status"]) || "open",
      }));
    const jobRiskScore = risks
      .filter((r) => linksTo(r["Job"], j.id))
      .reduce((max, r) => {
        const score = Number(r["Likelihood"] ?? 0) * Number(r["Impact"] ?? 0);
        return Math.max(max, score);
      }, 0);

    let priority: PriorityBand = "LOW";
    let attentionReason = "";
    for (const action of jobActions) {
      if (action.status === "done" || action.status === "closed" || action.status === "deferred") continue;
      const band = priorityBandForActionDueDate(action.dueDate);
      if (band !== "LOW" && !attentionReason) attentionReason = "Action due date pressure";
      priority = strongerBand(priority, band);
    }
    if (jobRiskScore > 0) {
      const riskBand = priorityBandForRiskScore(jobRiskScore);
      if (!attentionReason && riskBand !== "LOW") attentionReason = `Risk exposure (${jobRiskScore})`;
      priority = strongerBand(priority, riskBand);
    }

    return {
      id: j.id,
      jobId: j.id,
      name: str(j["Job_Name"]) || "(job)",
      status: str(j["Status"]) || "active",
      description: str(j["Description"]),
      milestone: nextPhase ? str(nextPhase["Phase_Name"]) : "",
      lastUpdated: dateOrNull(j["Last_Updated"]) ?? dateOrNull(j["Date_Completed"]),
      jobCode: "",
      priority,
      attentionReason,
      actions: jobActions,
    };
  });
}

export async function loadProjectPlan(ctx: OrgCtx): Promise<ProjectPlanWorkstreamView[]> {
  const rows = await (airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx));
  return scopeByJob(ctx, rows, (r) => r.jobId);
}
