// Org resolution for the platform routes. Tenancy is carried in the URL
// (/app/[org]/...), so the context is derived from the slug — no cookie.
// Portal routes bypass this entirely and validate PlatConPortalToken instead.
//
// Authentication: when Clerk is configured (lib/platform/authConfig), the
// signed-in user's email must match an active PlatCfgTeamMember of the org —
// view access for any role, writes for owner/builder/architect only. Without
// Clerk the platform runs in open demo mode (highest-privilege member acts as
// the current user).

import { redirect } from "next/navigation";
import { airtableEnabled } from "@/lib/airtable";
import {
  getOrgRegistry,
  listControlTeam,
  type ControlTeamMember,
} from "@/lib/platform/controlPlane";
import { clerkEnabled, platformAdminEmails } from "./authConfig";
import { reportingCapabilities } from "./reportingPolicy";
import {
  defaultModule1Governance,
  isAdminRole,
  isWriteRole,
  rolePriority,
} from "./module1Governance";
// Composite-aware normalization ("builder+finance") — keeps sub-roles on the
// viewer's role string so CLS/Approve checks (lib/platform/roles) can see them.
import { normalizeRoleString as normalizeTeamRole } from "./roles";
import {
  AiAuthority,
  DEFAULT_FEATURES,
  EngagementType,
  OrgConfig,
  OrgCtx,
} from "./types";

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseConfig(settingsRaw: string): OrgConfig {
  const settings = parseJson<Partial<OrgConfig>>(settingsRaw, {});
  return {
    assistant: {
      name: settings.assistant?.name ?? "Assistant",
      persona:
        settings.assistant?.persona ??
        "You are the AI project coordinator for this organisation. Be precise, data-driven, and flag risks proactively.",
    },
    // Spec 12 has no QUOTES/QUOTE_LINES table in any vertical template (roofing
    // estimation uses its own ROOFING_QUOTES flow), so the plat quotes feature
    // has no Airtable home — force it off in Airtable mode regardless of stored
    // config, so the nav + pages don't target a missing table.
    features: {
      ...DEFAULT_FEATURES,
      ...(settings.features ?? {}),
      ...(airtableEnabled() ? { quotes: false } : {}),
    },
    module1: settings.module1 ?? defaultModule1Governance(),
    branding: settings.branding?.logo ? { logo: settings.branding.logo } : undefined,
    generalJobId: typeof settings.generalJobId === "string" ? settings.generalJobId : undefined,
    tenantDatabaseUrl:
      typeof settings.tenantDatabaseUrl === "string" && settings.tenantDatabaseUrl
        ? settings.tenantDatabaseUrl
        : undefined,
  };
}

/** Signed-in user's primary email via Clerk, or null in demo mode. */
export async function getAuthEmail(): Promise<string | null> {
  if (!clerkEnabled()) return null;
  const { currentUser } = await import("@clerk/nextjs/server");
  const user = await currentUser();
  return user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null;
}

/** Find a team member by email in the control plane's team registry. */
async function findMember(ctx: OrgCtx, email: string): Promise<ControlTeamMember | null> {
  const members = await listControlTeam(ctx.orgSlug);
  const member = members.find((m) => m.email.toLowerCase() === email) ?? null;
  return member ? { ...member, role: normalizeTeamRole(member.role) } : null;
}

export async function getOrgCtx(orgSlug: string): Promise<OrgCtx | null> {
  const e = await getOrgRegistry(orgSlug);
  if (!e || !e.isActive) return null;
  return {
    orgId: e.orgId,
    orgSlug: e.slug,
    orgName: e.name,
    vertical: e.vertical,
    defaultEngagementType: e.defaultEngagementType as EngagementType,
    allowedEngagementTypes: parseJson<EngagementType[]>(e.allowedEngagementTypes, [
      e.defaultEngagementType as EngagementType,
    ]),
    aiAuthority: e.aiAuthority as AiAuthority,
    config: parseConfig(e.settings),
  };
}

/** Resolve the org or bounce to the org picker. First line of every platform
 *  page/action. With Clerk active, the user must also be an active member. */
export async function requireOrgCtx(orgSlug: string): Promise<OrgCtx> {
  const ctx = await getOrgCtx(orgSlug);
  if (!ctx) redirect("/app");

  const email = await getAuthEmail();
  if (email !== null) {
    const member = await findMember(ctx, email);
    if (!member) redirect("/app?denied=1");
  }
  return ctx;
}

export interface CurrentUser {
  name: string;
  role: string;
  email: string;
}

export async function getCurrentViewer(ctx: OrgCtx): Promise<CurrentUser> {
  const email = await getAuthEmail();
  if (email !== null) {
    const member = await findMember(ctx, email);
    if (!member) redirect("/app?denied=1");
    return { name: member.name, role: normalizeTeamRole(member.role), email: member.email };
  }
  const members = await listControlTeam(ctx.orgSlug);
  const member = [...members].sort((a, b) => rolePriority(a.role) - rolePriority(b.role))[0];
  return member
    ? { name: member.name, role: normalizeTeamRole(member.role), email: member.email }
    : { name: "Demo User", role: "owner", email: "" };
}

/** Current user for actor stamping. Called on every mutation path, so with
 *  Clerk active it doubles as the write gate: non-members are bounced and
 *  broker/read-only members cannot mutate. Demo mode returns the highest
 *  privilege active member. */
export async function getCurrentUser(ctx: OrgCtx): Promise<CurrentUser> {
  const user = await getCurrentViewer(ctx);
  if (!isWriteRole(user.role)) {
    throw new Error("Your role in this organisation is read-only — writes are not permitted.");
  }
  return user;
}

/** Financial-surface gate (Spec 12 Module 8: the Budget Dashboard is Owner
 *  role only — no financial view for Builder, Architect, or Broker). Used by
 *  the budget/cashflow/accounting pages and their server actions; non-owner
 *  roles are bounced to the org dashboard. */
export async function requireFinancialAccess(ctx: OrgCtx): Promise<CurrentUser> {
  const user = await getCurrentViewer(ctx);
  if (!reportingCapabilities(user.role).showFinancialDetail) {
    redirect(`/app/${ctx.orgSlug}?denied=financial`);
  }
  return user;
}

/** Admin-only gate for destructive/config operations. */
export async function requireAdmin(ctx: OrgCtx): Promise<CurrentUser> {
  const user = await getCurrentUser(ctx);
  if (clerkEnabled() && !isAdminRole(user.role)) {
    throw new Error("This operation requires the admin role.");
  }
  return user;
}

/** Platform-operator gate: provisioning new customer organisations is an
 *  internal operation (doc module 1), not something any signed-in user may
 *  do. Demo mode is open by definition; with auth on, the user's email must
 *  be in PLATFORM_ADMIN_EMAILS. */
export async function isPlatformAdmin(): Promise<boolean> {
  if (!clerkEnabled()) return true; // demo mode (already gated fail-closed by the proxy)
  const email = await getAuthEmail();
  return !!email && platformAdminEmails().includes(email);
}
