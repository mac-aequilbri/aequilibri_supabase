// Scheduled automation (the doc's n8n role): correction processing at
// volume, periodic Intelligence Snapshots, and optional weekly report
// drafts. Invoked by /api/platform/scheduler — point any scheduler at it
// (GitHub Actions cron ships with the repo; n8n/Render cron can call the
// same endpoint later).
//
// Cadence is self-managing so the caller can fire hourly without thought:
//  - hypothesis engine: every run (cheap; no-op when nothing unclustered)
//  - intelligence snapshot: when the latest is older than 6 days
//  - weekly report drafts: Mondays (UTC), for active jobs missing a draft
//    for the current week — opt-in per org (costs AI tokens) via the
//    PlatCfgSetting "automation.weekly_reports" = true

import { listOrgRegistry } from "@/lib/platform/controlPlane";
import { prisma } from "@/lib/db";
import { getOrgCtx } from "@/lib/platform/org-context";
import { redriveOutbox } from "@/lib/platform/outbox";
import { generateWeeklyReport } from "./construction/reports";
import { runHypothesisEngine, snapshotIntelligence } from "./learning";

const SNAPSHOT_MAX_AGE_DAYS = 6;

export interface SchedulerRunResult {
  orgs: number;
  hypotheses: { created: number; updated: number };
  snapshots: number;
  reportsDrafted: number;
  outbox: { redriven: number; deadLettered: number };
  errors: string[];
}

async function wantsAutoReports(orgId: number): Promise<boolean> {
  const setting = await prisma.platCfgSetting.findFirst({
    where: { orgId, key: "automation.weekly_reports" },
  });
  if (!setting) return false;
  try {
    return JSON.parse(setting.value) === true;
  } catch {
    return false;
  }
}

function lastSunday(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // back to Sunday
  return d;
}

// Overlap guard: an hourly cron retrying into a still-running pass (AI calls
// make a run minutes-long) would duplicate snapshots/report drafts — the
// per-org checks are check-then-act, not atomic. One run at a time per
// instance; a concurrent trigger returns immediately with a marker error.
let schedulerRunning = false;

export async function runScheduledTasks(now = new Date()): Promise<SchedulerRunResult> {
  if (schedulerRunning) {
    return {
      orgs: 0,
      hypotheses: { created: 0, updated: 0 },
      snapshots: 0,
      reportsDrafted: 0,
      outbox: { redriven: 0, deadLettered: 0 },
      errors: ["Scheduler run already in progress — skipped"],
    };
  }
  schedulerRunning = true;
  try {
    return await runScheduledTasksInner(now);
  } finally {
    schedulerRunning = false;
  }
}

async function runScheduledTasksInner(now: Date): Promise<SchedulerRunResult> {
  const result: SchedulerRunResult = {
    orgs: 0,
    hypotheses: { created: 0, updated: 0 },
    snapshots: 0,
    reportsDrafted: 0,
    outbox: { redriven: 0, deadLettered: 0 },
    errors: [],
  };

  // §2b rule 8/registry principle: org enumeration always goes through the
  // control plane (Airtable control base or PlatOrganisation, resolved there).
  const orgs: { id: number; slug: string }[] = (await listOrgRegistry()).map((o) => ({
    id: o.orgId,
    slug: o.slug,
  }));
  for (const org of orgs) {
    const ctx = await getOrgCtx(org.slug);
    if (!ctx) continue;
    result.orgs++;

    // 1. Correction processing (doc Phase 3 pipeline).
    try {
      const engine = await runHypothesisEngine(ctx);
      result.hypotheses.created += engine.created;
      result.hypotheses.updated += engine.updated;
    } catch (err) {
      result.errors.push(`${org.slug} hypothesis engine: ${err}`);
    }

    // 2. Periodic Intelligence Snapshot.
    try {
      const latest = await prisma.platIntelligenceSnapshot.findFirst({
        where: { orgId: ctx.orgId },
        orderBy: { capturedAt: "desc" },
      });
      const ageDays = latest
        ? (now.getTime() - latest.capturedAt.getTime()) / 86_400_000
        : Infinity;
      if (ageDays > SNAPSHOT_MAX_AGE_DAYS) {
        await snapshotIntelligence(ctx);
        result.snapshots++;
      }
    } catch (err) {
      result.errors.push(`${org.slug} snapshot: ${err}`);
    }

    // 3. Weekly report drafts (opt-in; Mondays UTC).
    try {
      if (now.getUTCDay() === 1 && (await wantsAutoReports(ctx.orgId))) {
        const weekEnding = lastSunday(now);
        const jobs = await prisma.platJob.findMany({
          where: { orgId: ctx.orgId, status: "active" },
          select: { id: true },
        });
        for (const job of jobs) {
          const existing = await prisma.platConWeeklyReport.findFirst({
            where: { orgId: ctx.orgId, jobId: job.id, weekEnding },
          });
          if (existing) continue;
          await generateWeeklyReport(
            ctx,
            "scheduler",
            job.id,
            weekEnding.toISOString().slice(0, 10),
          );
          result.reportsDrafted++;
        }
      }
    } catch (err) {
      result.errors.push(`${org.slug} reports: ${err}`);
    }
  }

  // 4. Outbound outbox retry/DLQ — a single cross-org control-base sweep (the
  // outbox is one shared table, not per-org). Re-drives failed rows under the
  // attempt cap; dead-letters the rest.
  try {
    result.outbox = await redriveOutbox();
  } catch (err) {
    result.errors.push(`outbox redrive: ${err}`);
  }

  // Log only orgs where the run actually did something (or failed) — hourly
  // no-op heartbeats would drown the audit log.
  const didWork =
    result.snapshots > 0 ||
    result.reportsDrafted > 0 ||
    result.hypotheses.created + result.hypotheses.updated > 0 ||
    result.outbox.redriven + result.outbox.deadLettered > 0;
  if (didWork || result.errors.length) {
    await prisma.platExecutionLog
      .createMany({
        data: orgs
          .filter((org) => result.errors.some((e) => e.startsWith(org.slug)) || didWork)
          .map((org) => ({
            orgId: org.id,
            actorType: "system",
            actorName: "scheduler",
            operation: "generate",
            targetTable: "scheduler_run",
            payload: JSON.stringify({
              snapshots: result.snapshots,
              hypotheses: result.hypotheses,
              reportsDrafted: result.reportsDrafted,
            }),
            status: result.errors.length ? "failed" : "executed",
            executedAt: now,
            error: result.errors.filter((e) => e.startsWith(org.slug)).join("; ").slice(0, 900),
          })),
      })
      .catch(() => {});
  }

  return result;
}
