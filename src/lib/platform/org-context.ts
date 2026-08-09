// Org resolution for the platform routes. Tenancy is carried in the URL
// (/app/[org]/...), so the context is derived from the slug — no cookie.
// Portal routes bypass this entirely and validate PlatConPortalToken instead.
//
// Authentication: when Clerk is configured (lib/platform/authConfig), the
// signed-in user's email must match an active PlatCfgTeamMember of the org —
// view access for any role, writes for owner/builder/architect only. Without
// Clerk the platform runs in open demo mode (highest-privilege member acts as
// the current user).
//
// The request-free core (registry → OrgCtx, email → member) lives in
// lib/platform/principal (MCP plan W1b); this module adds the page-flavored
// behavior on top: Clerk identity lookup and redirect-on-denied.

import { redirect } from "next/navigation";
import { clerkEnabled, platformAdminEmails } from "./authConfig";
import { reportingCapabilities } from "./reportingPolicy";
import { isAdminRole, isWriteRole } from "./module1Governance";
import {
  resolveDefaultMember,
  resolveMember,
  resolveOrgCtx,
  type CurrentUser,
} from "./principal";
import { OrgCtx } from "./types";

export type { CurrentUser } from "./principal";

/** Signed-in user's primary email via Clerk, or null in demo mode. */
export async function getAuthEmail(): Promise<string | null> {
  if (!clerkEnabled()) return null;
  const { currentUser } = await import("@clerk/nextjs/server");
  const user = await currentUser();
  return user?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null;
}

export async function getOrgCtx(orgSlug: string): Promise<OrgCtx | null> {
  return resolveOrgCtx(orgSlug);
}

/** Resolve the org or bounce to the org picker. First line of every platform
 *  page/action. With Clerk active, the user must also be an active member. */
export async function requireOrgCtx(orgSlug: string): Promise<OrgCtx> {
  const ctx = await getOrgCtx(orgSlug);
  if (!ctx) redirect("/app");

  const email = await getAuthEmail();
  if (email !== null) {
    const member = await resolveMember(ctx, email);
    if (!member) redirect("/app?denied=1");
  }
  return ctx;
}

export async function getCurrentViewer(ctx: OrgCtx): Promise<CurrentUser> {
  const email = await getAuthEmail();
  if (email !== null) {
    const member = await resolveMember(ctx, email);
    if (!member) redirect("/app?denied=1");
    return member;
  }
  const member = await resolveDefaultMember(ctx);
  return member ?? { name: "Demo User", role: "owner", email: "" };
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
