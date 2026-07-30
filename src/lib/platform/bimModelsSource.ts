import { db, prisma } from "@/lib/db";
import type { OrgCtx } from "./types";

export interface BimModelView {
  id: string;
  name: string;
  embedUrl: string;
  clientVisible: boolean;
  addedBy: string;
  notes: string;
  createdAt: Date | null;
}

export interface JobBimModelsView {
  job: { id: string; name: string };
  models: BimModelView[];
}

async function fromPostgres(ctx: OrgCtx, id: string): Promise<JobBimModelsView | null> {
  const jobId = Number(id);
  if (!Number.isInteger(jobId)) return null;
  const job = await db(ctx).platJob.findFirst({
    where: { id: jobId, orgId: ctx.orgId },
    select: { id: true, name: true },
  });
  if (!job) return null;
  const models = await db(ctx).platConBimModel.findMany({
    where: { jobId, orgId: ctx.orgId },
    orderBy: { createdAt: "desc" },
  });
  return {
    job: { id: String(job.id), name: job.name },
    models: models.map((m) => ({
      id: String(m.id),
      name: m.name,
      embedUrl: m.embedUrl,
      clientVisible: m.clientVisible,
      addedBy: m.addedBy,
      notes: m.notes,
      createdAt: m.createdAt,
    })),
  };
}

export function loadJobBimModels(ctx: OrgCtx, jobId: string): Promise<JobBimModelsView | null> {
  return fromPostgres(ctx, jobId);
}
