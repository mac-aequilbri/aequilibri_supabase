"use server";

import { redirect } from "next/navigation";
import { VERTICAL_TEMPLATE_BASE_IDS } from "@/lib/airtable/config";
import { getTemplateRegistryEntry } from "@/lib/platform/controlPlane";
import { clerkEnabled } from "@/lib/platform/authConfig";
import { normalizeTeamRole, type TeamRole } from "@/lib/platform/module1Governance";
import { AiAuthority, DEFAULT_FEATURES, EngagementType } from "@/lib/platform/types";
import { provisionOrganisation } from "@/services/platform/onboarding";

const ENGAGEMENT_TYPES: EngagementType[] = ["short_job", "long_project", "ongoing", "seasonal"];
const AUTHORITIES: AiAuthority[] = ["propose_only", "approve_required", "auto_low_risk"];
const VERTICALS = Object.keys(VERTICAL_TEMPLATE_BASE_IDS);

export async function provisionOrgAction(formData: FormData): Promise<void> {
  const { isPlatformAdmin } = await import("@/lib/platform/org-context");
  if (!(await isPlatformAdmin())) redirect("/app?denied=admin");

  const defaultEngagementType = String(formData.get("defaultEngagementType") ?? "long_project");
  const aiAuthority = String(formData.get("aiAuthority") ?? "approve_required");
  const adminRole = normalizeTeamRole(String(formData.get("adminRole") ?? "owner")) as TeamRole;

  const allowedEngagementTypes = ENGAGEMENT_TYPES.filter(
    (t) => formData.get(`engagement_${t}`) === "on",
  );
  const features: Record<string, boolean> = {};
  for (const key of Object.keys(DEFAULT_FEATURES)) {
    features[key] = formData.get(`feature_${key}`) === "on";
  }
  const lines = (name: string) =>
    String(formData.get(name) ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

  // Optional company logo. Stored inline in settings as a data URL, so it is
  // capped small: the registry's Settings field is bounded long-text. Reject
  // anything non-image or too big rather than silently truncating.
  const LOGO_MAX_BYTES = 64 * 1024;
  let logoDataUrl: string | undefined;
  const logo = formData.get("logo");
  if (logo instanceof File && logo.size > 0) {
    if (!logo.type.startsWith("image/")) {
      redirect(`/app/new?error=${encodeURIComponent("Logo must be an image file (PNG, SVG, JPG…).")}`);
    }
    if (logo.size > LOGO_MAX_BYTES) {
      redirect(
        `/app/new?error=${encodeURIComponent(
          `Logo is ${(logo.size / 1024).toFixed(0)} KB — please upload one under 64 KB (an SVG or optimised PNG is ideal).`,
        )}`,
      );
    }
    const base64 = Buffer.from(await logo.arrayBuffer()).toString("base64");
    logoDataUrl = `data:${logo.type};base64,${base64}`;
  }

  // With Clerk active, default the first team member to the signing-in user so the
  // creator is a member of (and can access) the org they just provisioned.
  let adminName = String(formData.get("adminName") ?? "");
  let adminEmail = String(formData.get("adminEmail") ?? "");
  if (clerkEnabled() && !adminEmail.trim()) {
    const { currentUser } = await import("@clerk/nextjs/server");
    const user = await currentUser();
    adminEmail = user?.primaryEmailAddress?.emailAddress ?? "";
    adminName = adminName.trim() || user?.fullName || adminEmail.split("@")[0] || "Admin";
  }

  // Resolve the selected industry option. A registry recordId ("rec…") resolves
  // to its vertical key + template base; a bare vertical key is the fallback
  // when the registry is empty (template then resolved by the hardcoded map).
  const option = String(formData.get("templateOption") ?? "");
  let vertical = VERTICALS[0];
  let templateBaseId = "";
  let industryLabel = "";
  let subIndustryLabel = "";
  if (option.startsWith("rec")) {
    const entry = await getTemplateRegistryEntry(option);
    if (!entry) redirect(`/app/new?error=${encodeURIComponent("Selected industry mapping not found — refresh and retry.")}`);
    vertical = entry.verticalKey || VERTICALS[0];
    templateBaseId = entry.templateBaseId;
    industryLabel = entry.industry;
    subIndustryLabel = entry.subIndustry;
  } else if (VERTICALS.includes(option)) {
    vertical = option;
  }

  const result = await provisionOrganisation({
    slug: String(formData.get("slug") ?? ""),
    name: String(formData.get("name") ?? ""),
    vertical,
    templateBaseId: templateBaseId || undefined,
    airtableBaseId: String(formData.get("airtableBaseId") ?? ""),
    defaultEngagementType: (ENGAGEMENT_TYPES.includes(defaultEngagementType as EngagementType)
      ? defaultEngagementType
      : "long_project") as EngagementType,
    allowedEngagementTypes,
    aiAuthority: (AUTHORITIES.includes(aiAuthority as AiAuthority)
      ? aiAuthority
      : "approve_required") as AiAuthority,
    assistantName: String(formData.get("assistantName") ?? ""),
    assistantPersona: String(formData.get("assistantPersona") ?? ""),
    features,
    adminName,
    adminEmail,
    adminRole,
    budgetCategories: lines("budgetCategories"),
    clientPriorities: lines("clientPriorities"),
    tradeReferences: lines("tradeReferences"),
    initialRules: lines("initialRules"),
    logoDataUrl,
    industryLabel,
    subIndustryLabel,
  });

  if (!result.ok) {
    redirect(`/app/new?error=${encodeURIComponent(result.error)}`);
  }
  redirect(`/app/${result.slug}`);
}
