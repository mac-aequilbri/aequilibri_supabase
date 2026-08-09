// MCP session resolution (mcp-assistant-plan W2) — turns an incoming request
// on /api/mcp/[org] into the authenticated (OrgCtx, member) pair every tool
// call runs under. The plan's one rule: a tool call without this session must
// be impossible, and the org NEVER comes from the request body — it comes
// from the URL slug, and the presented key must verify against THAT org's
// registry (a leaked key for org A fails on org B's endpoint).
//
// Two credential kinds share one auth chain, fail-closed at each step:
//   1. slug → control-plane registry → OrgCtx (404 unknown/inactive org)
//   2. the bearer credential resolves to a member EMAIL:
//        - `aeq_mcp_…` API key (machine consumers, plan W2/W3): SHA-256 must
//          match one of the org's stored key hashes (401; constant-time)
//        - anything else is treated as an OAuth access token (human
//          consumers, plan W4): resolved via the configured authorization
//          server's userinfo endpoint (401 when invalid or OAuth is off)
//   3. the org must have an active `mcp:in` connection row — the per-org
//      kill switch, same default-deny the hooks route applies (403)
//   4. the email must be an active org member (403) — their role drives
//      tool gating and RLS job scoping downstream. An OAuth token grants
//      nothing an org hasn't granted that member.

import { createHash, timingSafeEqual } from "node:crypto";
import { platformAdminEmails } from "@/lib/platform/authConfig";
import { getActiveConnection, getOrgMcpKeys } from "@/lib/platform/controlPlane";
import { resolveMember, resolveOrgCtx, type CurrentUser } from "@/lib/platform/principal";
import type { Actor, OrgCtx } from "@/lib/platform/types";
import { oauthEnabled, resolveOAuthEmail } from "./oauth";

export interface McpSession {
  ctx: OrgCtx;
  user: CurrentUser;
  /** Platform-operator sessions may use operator tools (onboarding_status).
   *  ALWAYS false for API-key sessions; the in-process client (plan W5) sets
   *  it from isPlatformAdmin() where a real request context exists. */
  platformAdmin?: boolean;
  /** Restricts the session to a tool subset (the in-app agent bundles). No
   *  value = the full MCP surface, as for external API-key sessions. */
  tools?: readonly string[];
  /** Actor override for audit attribution. External sessions default to
   *  `mcp:<member email>`; the in-app client passes the chat actor so write
   *  provenance (assistant name, sourceMessageId) is unchanged by the MCP
   *  routing. */
  actor?: Actor;
}

export type McpSessionResult =
  | { ok: true; session: McpSession }
  | { ok: false; status: number; error: string };

/** SHA-256 hex of a plaintext key — the only form ever stored or compared. */
export function hashMcpKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function hashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const API_KEY_PREFIX = "aeq_mcp_";

/** Steps 3–4 shared by both credential kinds: the org's kill switch, then
 *  membership — the walls that make a credential worth exactly what the org
 *  granted its member. */
async function sessionForEmail(
  ctx: OrgCtx,
  email: string,
  opts: { platformAdmin: boolean; memberGoneError: string },
): Promise<McpSessionResult> {
  if (!(await getActiveConnection(ctx.orgSlug, "mcp", "in"))) {
    return { ok: false, status: 403, error: "MCP access is not enabled for this organisation" };
  }
  const user = await resolveMember(ctx, email);
  if (!user) return { ok: false, status: 403, error: opts.memberGoneError };
  return { ok: true, session: { ctx, user, platformAdmin: opts.platformAdmin } };
}

export async function resolveMcpSession(
  orgSlug: string,
  authorization: string | null,
): Promise<McpSessionResult> {
  const ctx = await resolveOrgCtx(orgSlug);
  if (!ctx) return { ok: false, status: 404, error: `Unknown organisation "${orgSlug}"` };

  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim() ?? "";
  if (!token) return { ok: false, status: 401, error: "Missing bearer token" };

  // Machine consumers: per-org API key. Never platform operators; the
  // in-process client (plan W5) is the only constructor of narrower sessions.
  if (token.startsWith(API_KEY_PREFIX)) {
    const presented = hashMcpKey(token);
    const keys = await getOrgMcpKeys(orgSlug);
    const match = keys.find((k) => hashesEqual(k.keyHash, presented));
    if (!match) return { ok: false, status: 401, error: "Invalid API key" };
    return sessionForEmail(ctx, match.memberEmail, {
      platformAdmin: false,
      memberGoneError: "The member this key acts as is no longer active in this organisation",
    });
  }

  // Human consumers (plan W4): an OAuth access token from the configured
  // authorization server. The token holder's email is the identity; platform
  // operators are the same PLATFORM_ADMIN_EMAILS set the app uses.
  if (!oauthEnabled()) {
    return { ok: false, status: 401, error: "Invalid API key" };
  }
  const email = await resolveOAuthEmail(token);
  if (!email) return { ok: false, status: 401, error: "Invalid or expired access token" };
  return sessionForEmail(ctx, email, {
    platformAdmin: platformAdminEmails().includes(email),
    memberGoneError: "This account is not an active member of this organisation",
  });
}
