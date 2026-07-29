"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  controlPlaneEnabled,
  deleteOrgFromRegistry,
  listControlTeam,
  saveMetricsSnapshot,
} from "@/lib/platform/controlPlane";
import { getAuthEmail, getOrgCtx, isPlatformAdmin } from "@/lib/platform/org-context";
import { loadOrgHighlights, type OrgHighlights } from "@/lib/platform/orgHighlightsSource";

// Offboard a client: remove it from the org registry so it disappears from the
// picker (and stops erroring when clicked). Admin-gated. Customer data is NOT
// deleted — the Airtable store surfaces the base id for manual removal
// (Airtable has no base-delete API); the Postgres store soft-deactivates the
// org, preserving its tenant data.
export async function deleteOrgAction(formData: FormData): Promise<void> {
  if (!(await isPlatformAdmin())) {
    redirect("/app?denied=admin");
  }
  const slug = String(formData.get("slug") ?? "").trim();
  if (!slug) {
    redirect("/app");
  }

  const result = await deleteOrgFromRegistry(slug);
  const baseId = result.baseId;

  revalidatePath("/app");
  redirect(`/app?deleted=${encodeURIComponent(slug)}${baseId ? `&base=${encodeURIComponent(baseId)}` : ""}`);
}

// Per-card highlights for the client picker. The picker renders the cached
// snapshot from the org registry instantly (see readMetricsSnapshot); this
// action is the refresh path — called by the card only when its cache is
// missing or past the TTL. It recomputes from the org's own data and writes the
// result back to the registry row (write-through) so the next picker load is a
// pure registry read again. Gated by the same membership check the picker
// uses: a signed-in user may only read orgs they belong to; demo mode sees all.
export async function fetchOrgHighlights(slug: string): Promise<OrgHighlights | null> {
  const clean = slug.trim();
  if (!clean) return null;

  const ctx = await getOrgCtx(clean);
  if (!ctx) return null;

  const email = await getAuthEmail();
  if (email !== null) {
    const emails = (await listControlTeam(clean)).map((m) => m.email.toLowerCase());
    if (!emails.includes(email)) return null;
  }

  const highlights = await loadOrgHighlights(ctx);

  // Write-through: refresh the registry-row cache so the next picker load is a
  // pure registry read. Best-effort — the caller still gets fresh numbers
  // even if the cache write fails.
  if (controlPlaneEnabled()) {
    try {
      await saveMetricsSnapshot(clean, { ...highlights, at: new Date().toISOString() });
    } catch {
      /* cache is an optimisation; never fail the read on a write miss */
    }
  }

  return highlights;
}
