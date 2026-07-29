import { airtableEnabled, core, type CoreRow } from "@/lib/airtable";
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function hasLinkedId(v: unknown, id: RecordId): boolean {
  return Array.isArray(v) && v.some((x) => String(x) === String(id));
}

export async function loadCapabilityDocuments(
  ctx: OrgCtx,
  docIds: RecordId[],
  jobId?: RecordId,
): Promise<CapabilityDocument[]> {
  if (docIds.length === 0) return [];

  if (airtableEnabled(ctx)) {
    const docs = await Promise.all(
      docIds
        .map((id) => String(id))
        .filter((id) => id.startsWith("rec"))
        .map((id) => core.get(ctx.orgSlug, "DOCUMENTS", id).catch(() => null)),
    );
    return docs
      .filter((d): d is CoreRow => Boolean(d))
      .filter((d) => (jobId == null ? true : hasLinkedId(d["Job"], jobId)))
      .map((d) => ({
        id: String(d.id),
        jobId: Array.isArray(d["Job"]) && d["Job"][0] ? String(d["Job"][0]) : undefined,
        title: str(d["Document_Name"]) || "(untitled)",
        text: str(d["Text_Content"]),
        classification: str(d["Classification"]) || str(d["Document_Type"]) || "other",
      }));
  }

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
