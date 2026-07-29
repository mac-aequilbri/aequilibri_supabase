"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setOrgAiAuthority } from "@/lib/platform/controlPlane";
import { requireAdmin, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";

const LEVELS = ["propose_only", "approve_required", "auto_low_risk"] as const;

/** Change the org's AI write-authority (governance §8). Admin-gated; the
 *  executor reads it per request, so it takes effect immediately (control
 *  cache TTL ≤ 60s). */
export async function setAiAuthorityAction(formData: FormData): Promise<void> {
  const ctx = await requireOrgCtx(String(formData.get("org") ?? ""));
  await requireAdmin(ctx);
  const level = String(formData.get("aiAuthority") ?? "");
  if (!(LEVELS as readonly string[]).includes(level)) {
    redirect(orgPath(ctx.orgSlug, "/agents?status=invalid"));
  }
  await setOrgAiAuthority(ctx.orgSlug, level);
  revalidatePath(orgPath(ctx.orgSlug, "/agents"));
  redirect(orgPath(ctx.orgSlug, `/agents?status=saved&level=${level}`));
}
