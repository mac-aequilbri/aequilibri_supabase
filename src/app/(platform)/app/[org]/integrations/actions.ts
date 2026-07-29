"use server";

import { revalidatePath } from "next/cache";
import {
  createConnection,
  deleteConnection,
  updateConnection,
  type ConnectionDirection,
} from "@/lib/platform/controlPlane";
import { requireAdmin, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";

const CHANNELS = new Set(["email", "slack", "form", "drive", "webhook"]);
const S = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

/** Resolve the org from the posted `org` field and enforce the admin role. */
async function gate(formData: FormData) {
  const ctx = await requireOrgCtx(S(formData, "org"));
  await requireAdmin(ctx);
  return ctx;
}

export async function addConnection(formData: FormData): Promise<void> {
  const ctx = await gate(formData);
  const channel = S(formData, "channel");
  const direction: ConnectionDirection = S(formData, "direction") === "out" ? "out" : "in";
  if (CHANNELS.has(channel)) {
    await createConnection({
      orgSlug: ctx.orgSlug,
      channel,
      direction,
      credentialRef: S(formData, "credentialRef"),
      eventFilter: S(formData, "eventFilter"),
      notes: S(formData, "notes"),
    });
  }
  revalidatePath(orgPath(ctx.orgSlug, "/integrations"));
}

export async function toggleConnection(formData: FormData): Promise<void> {
  const ctx = await gate(formData);
  const recordId = S(formData, "recordId");
  const isActive = S(formData, "isActive") === "true"; // current state → flip
  if (recordId) await updateConnection(recordId, { isActive: !isActive });
  revalidatePath(orgPath(ctx.orgSlug, "/integrations"));
}

export async function removeConnection(formData: FormData): Promise<void> {
  const ctx = await gate(formData);
  const recordId = S(formData, "recordId");
  if (recordId) await deleteConnection(recordId);
  revalidatePath(orgPath(ctx.orgSlug, "/integrations"));
}
