import { airtableEnabled, core } from "@/lib/airtable";
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function linksTo(v: unknown, recordId: string): boolean {
  return Array.isArray(v) && v.some((x) => String(x) === recordId);
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

async function fromAirtable(ctx: OrgCtx, id: string): Promise<JobBimModelsView | null> {
  if (!id.startsWith("rec")) return null;
  const job = await core.get(ctx.orgSlug, "JOBS", id).catch(() => null);
  if (!job) return null;
  const rows = await core.list(ctx.orgSlug, "BIM_MODELS", { maxRecords: 500 });
  const models = rows.filter((r) => linksTo(r["Job"], id)).map((r) => ({
    id: r.id,
    name: str(r["Name"]) || "(model)",
    embedUrl: str(r["Embed_URL"]),
    clientVisible: r["Client_Visible"] === true,
    addedBy: str(r["Added_By"]),
    notes: str(r["Notes"]),
    createdAt: null,
  }));
  return { job: { id: job.id, name: str(job["Job_Name"]) || "(job)" }, models };
}

export function loadJobBimModels(ctx: OrgCtx, jobId: string): Promise<JobBimModelsView | null> {
  return airtableEnabled(ctx) ? fromAirtable(ctx, jobId) : fromPostgres(ctx, jobId);
}
