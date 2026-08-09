// Principal-based org + member resolution (MCP plan W1b) — the request-free
// core of org-context: everything here takes explicit inputs (an org slug, a
// principal's email) and returns values, with no Clerk request context and no
// Next redirects. org-context.ts wraps these with the page-flavored behavior
// (Clerk lookup, redirect-on-denied); the planned MCP session layer calls
// them directly with an identity resolved from its own auth (API key/OAuth).

import { getOrgRegistry, listControlTeam } from "@/lib/platform/controlPlane";
import { defaultModule1Governance, rolePriority } from "./module1Governance";
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

export interface CurrentUser {
  name: string;
  role: string;
  email: string;
}

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
    features: {
      ...DEFAULT_FEATURES,
      ...(settings.features ?? {}),
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

/** Build the OrgCtx for an active org from the control-plane registry.
 *  Null for unknown or deactivated slugs. */
export async function resolveOrgCtx(orgSlug: string): Promise<OrgCtx | null> {
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

/** The org member a principal's email resolves to, role normalized — null
 *  when the email is not an active member (the caller decides how to deny). */
export async function resolveMember(ctx: OrgCtx, email: string): Promise<CurrentUser | null> {
  const members = await listControlTeam(ctx.orgSlug);
  const member = members.find((m) => m.email.toLowerCase() === email.toLowerCase()) ?? null;
  return member
    ? { name: member.name, role: normalizeTeamRole(member.role), email: member.email }
    : null;
}

/** Demo-mode fallback identity: the org's highest-privilege active member. */
export async function resolveDefaultMember(ctx: OrgCtx): Promise<CurrentUser | null> {
  const members = await listControlTeam(ctx.orgSlug);
  const member = [...members].sort((a, b) => rolePriority(a.role) - rolePriority(b.role))[0];
  return member
    ? { name: member.name, role: normalizeTeamRole(member.role), email: member.email }
    : null;
}
