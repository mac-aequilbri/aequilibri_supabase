import { db, prisma } from "@/lib/db";
import type { RecordId } from "@/lib/platform/recordWriter";
import type { OrgCtx } from "@/lib/platform/types";

export interface CapabilityDocument {
  id: RecordId;
  jobId?: RecordId;
  title: string;
  text: string;
  classification: string;
}

export async function loadCapabilityDocuments(
  ctx: OrgCtx,
  docIds: RecordId[],
  jobId?: RecordId,
): Promise<CapabilityDocument[]> {
  if (docIds.length === 0) return [];

  const numeric = docIds
    .map((id) => (typeof id === "number" ? id : Number(id)))
    .filter((id) => Number.isInteger(id));
  if (numeric.length === 0) return [];
  const rows = await db(ctx).platDocument.findMany({
    where: {
      orgId: ctx.orgId,
      id: { in: numeric },
      ...(typeof jobId === "number" ? { jobId } : {}),
    },
    select: { id: true, jobId: true, title: true, textContent: true, classification: true, docType: true },
  });
  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId ?? undefined,
    title: r.title,
    text: r.textContent || "",
    classification: r.classification || r.docType || "other",
  }));
}

export function parseDelimitedIds(raw: string): RecordId[] {
  return raw
    .split(/[,\n]/)
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => (/^\d+$/.test(v) ? Number(v) : v));
}
