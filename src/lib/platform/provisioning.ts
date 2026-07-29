// User provisioning — the login/invitation half of the governance framework's
// access-control model (the framework's §2.3/§7 define the Clerk role mapping
// but not how users get accounts; this module fills that gap).
//
// Design: the control plane's team registry (control-base PLAT_TEAM, or
// PlatCtlTeamMember in Postgres mode — see lib/platform/controlPlane) is the
// authoritative membership + role store; Clerk authenticates identity only.
// Inviting a user means
// creating their member row (org-context matches the signed-in Clerk email
// against it) and, when Clerk is active, sending a Clerk invitation email so
// they can create an account. A user who already has a Clerk account gains
// access the moment the row exists — no email needed.
//
// Deactivation is the reverse: Is_Active=false makes findMember miss, which
// revokes access within the control-cache TTL (60s). The Clerk account is left
// alone — it authenticates identity, membership is what authorizes.

import {
  createControlTeamMember,
  listControlTeamAll,
  updateControlTeamMember,
  type ControlTeamMember,
} from "@/lib/platform/controlPlane";
import { logger, errMeta } from "@/lib/logger";
import { clerkEnabled } from "./authConfig";
// Composite-aware ("builder+finance") — sub-roles survive storage; owner
// checks compare the parsed BASE role so "owner+business_owner" still counts.
import { normalizeRoleString as normalizeTeamRole, parseRole } from "./roles";
import type { OrgCtx } from "./types";

export type InviteStatus =
  | "invited" // member row created + Clerk invitation email sent
  | "added" // member row created; no email (demo mode, or they already have an account)
  | "reactivated" // an inactive row for this email existed — reactivated with the new role
  | "already_member"; // an active row already exists — nothing done

export interface InviteInput {
  name: string;
  email: string;
  role: string;
}

/** Every member of the org (active and inactive) from whichever store holds
 *  the registry, roles normalized. */
export async function listMembers(ctx: OrgCtx): Promise<ControlTeamMember[]> {
  const members = await listControlTeamAll(ctx.orgSlug);
  return members.map((m) => ({ ...m, role: normalizeTeamRole(m.role) }));
}

function findByEmail(members: ControlTeamMember[], email: string): ControlTeamMember | null {
  const e = email.toLowerCase();
  return members.find((m) => m.email.toLowerCase() === e) ?? null;
}

/** Would removing write access from `email` leave the org without an active
 *  owner? Guard against admin lockout — every org must keep one. */
function isLastActiveOwner(members: ControlTeamMember[], email: string): boolean {
  const e = email.toLowerCase();
  const owners = members.filter((m) => m.isActive && parseRole(m.role).base === "owner");
  return owners.length === 1 && owners[0].email.toLowerCase() === e;
}

async function patchMember(
  ctx: OrgCtx,
  email: string,
  patch: { role?: string; isActive?: boolean },
): Promise<boolean> {
  return updateControlTeamMember(ctx.orgSlug, email, patch);
}

/** Send a Clerk invitation email. Best-effort: an email that already has a
 *  Clerk account (or a pending invitation) is not an error — the member row
 *  is what grants access. */
async function sendClerkInvitation(email: string): Promise<"invited" | "skipped"> {
  if (!clerkEnabled()) return "skipped";
  try {
    const { clerkClient } = await import("@clerk/nextjs/server");
    const client = await clerkClient();
    await client.invitations.createInvitation({
      emailAddress: email,
      notify: true,
      ignoreExisting: true,
    });
    return "invited";
  } catch (err) {
    logger.warn("Clerk invitation not sent (existing account/invitation?)", {
      email,
      ...errMeta(err),
    });
    return "skipped";
  }
}

/** Invite a user to the org: create (or reactivate) their member row and send
 *  a Clerk invitation email when auth is active. */
export async function inviteMember(ctx: OrgCtx, input: InviteInput): Promise<InviteStatus> {
  const email = input.email.trim();
  const name = input.name.trim();
  const role = normalizeTeamRole(input.role);
  const members = await listMembers(ctx);
  const existing = findByEmail(members, email);

  if (existing?.isActive) return "already_member";
  if (existing) {
    await patchMember(ctx, email, { isActive: true, role });
    const sent = await sendClerkInvitation(email);
    return sent === "invited" ? "invited" : "reactivated";
  }

  await createControlTeamMember(ctx.orgSlug, { name, email, role });
  const sent = await sendClerkInvitation(email);
  return sent === "invited" ? "invited" : "added";
}

/** Change a member's role. Refuses to demote the last active owner. */
export async function setMemberRole(ctx: OrgCtx, email: string, role: string): Promise<void> {
  const next = normalizeTeamRole(role);
  const members = await listMembers(ctx);
  if (parseRole(next).base !== "owner" && isLastActiveOwner(members, email)) {
    throw new Error("Cannot demote the only active owner — promote another member first.");
  }
  const found = await patchMember(ctx, email, { role: next });
  if (!found) throw new Error("No team member with that email.");
}

/** Deactivate (revoke access) or reactivate a member. Refuses to deactivate
 *  the last active owner. */
export async function setMemberActive(ctx: OrgCtx, email: string, active: boolean): Promise<void> {
  const members = await listMembers(ctx);
  if (!active && isLastActiveOwner(members, email)) {
    throw new Error("Cannot deactivate the only active owner — promote another member first.");
  }
  const found = await patchMember(ctx, email, { isActive: active });
  if (!found) throw new Error("No team member with that email.");
}
