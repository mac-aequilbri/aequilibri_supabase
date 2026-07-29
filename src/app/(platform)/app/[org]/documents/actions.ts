"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { airtableEnabled } from "@/lib/airtable";
import { getCurrentUser, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";
import { recordIdParam } from "@/lib/platform/recordWriter";
import {
  analyzeDocument,
  ingestDocumentFile,
  ingestDocumentLink,
  ingestUnreadEmails,
  verifyStoredSnapshot,
} from "@/services/platform/documents";
import { loadDocumentDetail } from "@/lib/platform/documentsSource";
import { db, prisma } from "@/lib/db";
import type { CreateFormState } from "@/components/form/CreateForm";

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function uploadDocument(_prev: CreateFormState, formData: FormData): Promise<CreateFormState> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const user = await getCurrentUser(ctx);
  const jobId = recordIdParam(formData.get("jobId")) ?? undefined;
  const title = String(formData.get("title") ?? "").trim();
  const topic = String(formData.get("topic") ?? "").trim();
  const reference = String(formData.get("reference") ?? "").trim();
  const documentDate = String(formData.get("documentDate") ?? "").trim();
  const docType = String(formData.get("docType") ?? "").trim();
  const file = formData.get("file");
  const url = String(formData.get("url") ?? "").trim();

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return { error: "Couldn't save — the file is too large (max 5 MB). Nothing was recorded." };
    }
    const jobCode = !airtableEnabled(ctx) && typeof jobId === "number"
      ? (await db(ctx).platJob.findFirst({ where: { id: jobId, orgId: ctx.orgId }, select: { code: true } }))?.code
      : undefined;
    try {
      await ingestDocumentFile(ctx, user.name, {
        jobId,
        jobCode,
        title: title || file.name,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        buf: Buffer.from(await file.arrayBuffer()),
        topicHint: topic || undefined,
        referenceHint: reference || undefined,
        dateHint: documentDate || undefined,
        docTypeOverride: docType || undefined,
      });
    } catch (e) {
      console.error("[uploadDocument] file ingest rejected:", e);
      return { error: "Couldn't save the document — nothing was recorded. The org's base rejected the write; check the server log for details." };
    }
  } else if (url) {
    try {
      await ingestDocumentLink(ctx, user.name, {
        jobId,
        title: title || url,
        url,
        docType,
        topicHint: topic || undefined,
        referenceHint: reference || undefined,
        dateHint: documentDate || undefined,
      });
    } catch (e) {
      console.error("[uploadDocument] link ingest rejected:", e);
      return { error: "Couldn't save the link — nothing was recorded. The org's base rejected the write; check the server log for details." };
    }
  } else {
    return { error: "Nothing to save — choose a file or enter a link." };
  }

  revalidatePath(orgPath(ctx.orgSlug, "/documents"));
  redirect(orgPath(ctx.orgSlug, "/documents"));
}

export async function ingestInboxAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const user = await getCurrentUser(ctx);
  const jobId = recordIdParam(formData.get("jobId")) ?? undefined;
  const result = await ingestUnreadEmails(ctx, user.name, { jobId });
  revalidatePath(orgPath(ctx.orgSlug, "/documents"));
  redirect(
    orgPath(
      ctx.orgSlug,
      `/documents?processed=${result.processed}&documents=${result.documents}&proposals=${result.proposals}`,
    ),
  );
}

export async function verifyDocumentAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const id = String(formData.get("recordId") ?? "");
  if (!id) return;
  const doc = await loadDocumentDetail(ctx, id);
  let verify = "error";
  if (doc) {
    const result = await verifyStoredSnapshot(doc.storageProvider, doc.storageRef, doc.contentHash);
    verify = result.verified ? "ok" : doc.contentHash ? "fail" : "error";
  }
  revalidatePath(orgPath(ctx.orgSlug, `/documents/${id}`));
  redirect(orgPath(ctx.orgSlug, `/documents/${id}?verify=${verify}`));
}

export async function analyzeDocumentAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const user = await getCurrentUser(ctx);
  const id = recordIdParam(formData.get("recordId"));
  if (id == null) return;
  await analyzeDocument(ctx, user.name, id);
  revalidatePath(orgPath(ctx.orgSlug, `/documents/${id}`));
  revalidatePath(orgPath(ctx.orgSlug, "/documents"));
}
