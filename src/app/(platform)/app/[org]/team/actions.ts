"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { setControlAssignments, setProjectRlsEnforce } from "@/lib/platform/controlPlane";
import { requireAdmin, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";
import { inviteMember, setMemberActive, setMemberRole } from "@/lib/platform/provisioning";

// Team management actions (owner-gated). Errors with a user-facing message
// (last-owner guard, unknown email) surface via the status banner rather than
// the error boundary.

function back(orgSlug: string, qs: string): never {
  redirect(orgPath(orgSlug, `/team?${qs}`));
}

async function guarded(org: string) {
  const ctx = await requireOrgCtx(org);
  await requireAdmin(ctx);
  return ctx;
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  const ctx = await guarded(String(formData.get("org") ?? ""));
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    back(ctx.orgSlug, "status=invalid");
  }
  const status = await inviteMember(ctx, { name, email, role });
  revalidatePath(orgPath(ctx.orgSlug, "/team"));
  back(ctx.orgSlug, `status=${status}&who=${encodeURIComponent(email)}`);
}

export async function setMemberRoleAction(formData: FormData): Promise<void> {
  const ctx = await guarded(String(formData.get("org") ?? ""));
  const email = String(formData.get("email") ?? "").trim();
  const role = String(formData.get("role") ?? "").trim();
  try {
    await setMemberRole(ctx, email, role);
  } catch (err) {
    back(ctx.orgSlug, `status=error&msg=${encodeURIComponent(err instanceof Error ? err.message : "Update failed.")}`);
  }
  revalidatePath(orgPath(ctx.orgSlug, "/team"));
  back(ctx.orgSlug, `status=role_updated&who=${encodeURIComponent(email)}`);
}

/** Replace a member's project (job) assignments — the RLS access list. The
 *  checklist posts one `jobId` per checked project; an empty set clears access.
 *  See docs/project-rls-activation.md (P1). */
export async function setMemberAssignmentsAction(formData: FormData): Promise<void> {
  const ctx = await guarded(String(formData.get("org") ?? ""));
  const email = String(formData.get("email") ?? "").trim();
  const jobIds = formData.getAll("jobId").map((v) => String(v)).filter(Boolean);
  if (!email) back(ctx.orgSlug, "status=error&msg=Missing+member");
  try {
    await setControlAssignments(ctx.orgSlug, email, jobIds);
  } catch (err) {
    back(ctx.orgSlug, `status=error&msg=${encodeURIComponent(err instanceof Error ? err.message : "Update failed.")}`);
  }
  revalidatePath(orgPath(ctx.orgSlug, "/team"));
  back(ctx.orgSlug, `status=projects_updated&who=${encodeURIComponent(email)}`);
}

/** Flip project-level access enforcement for this org (P3). When ON, members
 *  see only their assigned projects; enable only AFTER assigning members, or
 *  non-exempt users will see empty lists. Admins always retain full access. */
export async function setProjectRlsEnforceAction(formData: FormData): Promise<void> {
  const ctx = await guarded(String(formData.get("org") ?? ""));
  const enabled = String(formData.get("enabled") ?? "") === "1";
  try {
    await setProjectRlsEnforce(ctx.orgSlug, enabled);
  } catch (err) {
    back(ctx.orgSlug, `status=error&msg=${encodeURIComponent(err instanceof Error ? err.message : "Update failed.")}`);
  }
  revalidatePath(orgPath(ctx.orgSlug, "/team"));
  back(ctx.orgSlug, `status=${enabled ? "rls_enabled" : "rls_disabled"}`);
}

export async function setMemberActiveAction(formData: FormData): Promise<void> {
  const ctx = await guarded(String(formData.get("org") ?? ""));
  const email = String(formData.get("email") ?? "").trim();
  const active = String(formData.get("active") ?? "") === "1";
  try {
    await setMemberActive(ctx, email, active);
  } catch (err) {
    back(ctx.orgSlug, `status=error&msg=${encodeURIComponent(err instanceof Error ? err.message : "Update failed.")}`);
  }
  revalidatePath(orgPath(ctx.orgSlug, "/team"));
  back(ctx.orgSlug, `status=${active ? "reactivated_member" : "deactivated"}&who=${encodeURIComponent(email)}`);
}
