"use server";

import { redirect } from "next/navigation";
import { requireAdmin, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";

// Schema-drift migration retired with the Airtable backend: there are no
// cloned bases left to bring up to the template schema. Kept as a stub so any
// in-flight form post still lands somewhere sensible. Admin-gated.
export async function migrateBaseAction(formData: FormData): Promise<void> {
  const org = String(formData.get("org") ?? "");
  const ctx = await requireOrgCtx(org);
  await requireAdmin(ctx);
  redirect(orgPath(ctx.orgSlug, "/schema-drift?status=unavailable"));
}
