"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentUser, getCurrentViewer, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";
import { recordIdParam } from "@/lib/platform/recordWriter";
import { reportingCapabilities } from "@/lib/platform/reportingPolicy";
import { loadReportDetail } from "@/lib/platform/reportDetailSource";
import {
  approveReport,
  generateCustomReport,
  generateReport,
  markReportSent,
} from "@/services/platform/construction/reports";

export async function generateReportAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const user = await getCurrentUser(ctx);
  const viewer = await getCurrentViewer(ctx);
  const caps = reportingCapabilities(viewer.role);
  if (!caps.canGenerateReports) throw new Error("Your role cannot generate reports.");
  const jobId = recordIdParam(formData.get("jobId"));
  const reportId = String(formData.get("reportId") ?? "") || "weekly_progress";
  const periodEnding =
    String(formData.get("weekEnding") ?? "") || new Date().toISOString().slice(0, 10);
  if (jobId == null) return;

  const { id } = await generateReport(
    ctx,
    { name: user.name, financeDetail: caps.showFinancialDetail },
    reportId,
    jobId,
    periodEnding,
  );
  revalidatePath(orgPath(ctx.orgSlug, "/reports"));
  redirect(orgPath(ctx.orgSlug, id ? `/reports/${id}` : "/reports"));
}

export async function generateCustomReportAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const user = await getCurrentUser(ctx);
  const viewer = await getCurrentViewer(ctx);
  const caps = reportingCapabilities(viewer.role);
  if (!caps.canGenerateReports) throw new Error("Your role cannot generate reports.");
  const jobId = recordIdParam(formData.get("jobId"));
  const prompt = String(formData.get("prompt") ?? "").trim();
  const periodEnding =
    String(formData.get("weekEnding") ?? "") || new Date().toISOString().slice(0, 10);
  const scopes = formData.getAll("scopes").map(String);
  if (jobId == null || !prompt) return;

  const { id } = await generateCustomReport(
    ctx,
    { name: user.name, financeDetail: caps.showFinancialDetail },
    { jobId, periodEnding, prompt, scopes },
  );
  revalidatePath(orgPath(ctx.orgSlug, "/reports"));
  redirect(orgPath(ctx.orgSlug, id ? `/reports/${id}` : "/reports"));
}

/** Promote a custom report's promptSpec to a reusable saved template
 *  (PLAT_REPORT_CATALOG) — it then appears in the Reports dropdown. */
export async function saveTemplateAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const viewer = await getCurrentViewer(ctx);
  if (!reportingCapabilities(viewer.role).canGenerateReports) {
    throw new Error("Your role cannot manage report templates.");
  }
  const recordId = recordIdParam(formData.get("recordId"));
  if (recordId == null) return;
  const report = await loadReportDetail(ctx, String(recordId));
  const spec = report?.promptSpec;
  if (!spec) return;

  // Optional user-supplied name; fall back to the prompt-derived title.
  const templateTitle = String(formData.get("templateTitle") ?? "").trim();
  const { createReportTemplate } = await import("@/lib/platform/controlPlane");
  await createReportTemplate({
    orgSlug: ctx.orgSlug,
    key: `tpl_${Date.now().toString(36)}`,
    title: templateTitle || spec.prompt.slice(0, 60) + (spec.prompt.length > 60 ? "…" : ""),
    prompt: spec.prompt,
    scopes: spec.scopes,
  });
  revalidatePath(orgPath(ctx.orgSlug, "/reports"));
  redirect(orgPath(ctx.orgSlug, "/reports"));
}

/** Re-run a custom report's stored promptSpec against fresh data; the record
 *  is updated in place and returns to draft. */
export async function regenerateReportAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const user = await getCurrentUser(ctx);
  const viewer = await getCurrentViewer(ctx);
  const caps = reportingCapabilities(viewer.role);
  if (!caps.canGenerateReports) throw new Error("Your role cannot generate reports.");
  const recordId = recordIdParam(formData.get("recordId"));
  if (recordId == null) return;
  const report = await loadReportDetail(ctx, String(recordId));
  const spec = report?.promptSpec;
  if (!spec?.jobId) return;

  await generateCustomReport(
    ctx,
    { name: user.name, financeDetail: caps.showFinancialDetail },
    {
      jobId: spec.jobId,
      periodEnding:
        report?.weekEnding?.toISOString().slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      prompt: spec.prompt,
      scopes: spec.scopes,
      recordId,
    },
  );
  revalidatePath(orgPath(ctx.orgSlug, `/reports/${recordId}`));
  redirect(orgPath(ctx.orgSlug, `/reports/${recordId}`));
}

export async function approveReportAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const user = await getCurrentUser(ctx);
  const id = recordIdParam(formData.get("recordId"));
  if (id != null) await approveReport(ctx, user.name, id);
  revalidatePath(orgPath(ctx.orgSlug, `/reports/${id}`));
  revalidatePath(orgPath(ctx.orgSlug, "/reports"));
}

export async function markSentAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  const user = await getCurrentUser(ctx);
  const id = recordIdParam(formData.get("recordId"));
  if (id != null) await markReportSent(ctx, user.name, id);
  revalidatePath(orgPath(ctx.orgSlug, `/reports/${id}`));
  revalidatePath(orgPath(ctx.orgSlug, "/reports"));
}
