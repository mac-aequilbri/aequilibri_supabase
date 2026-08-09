// MCP session resolution (mcp-assistant-plan W2) — turns an incoming request
// on /api/mcp/[org] into the authenticated (OrgCtx, member) pair every tool
// call runs under. The plan's one rule: a tool call without this session must
// be impossible, and the org NEVER comes from the request body — it comes
// from the URL slug, and the presented key must verify against THAT org's
// registry (a leaked key for org A fails on org B's endpoint).
//
// Auth chain, fail-closed at each step:
//   1. slug → control-plane registry → OrgCtx (404 unknown/inactive org)
//   2. Bearer key → SHA-256 → must match one of the org's stored key hashes
//      (401; constant-time compare)
//   3. the org must have an active `mcp:in` connection row — the per-org
//      kill switch, same default-deny the hooks route applies (403)
//   4. the key's bound member must still be an active org member (403) —
//      their role drives tool gating and RLS job scoping downstream.

import { createHash, timingSafeEqual } from "node:crypto";
import { getActiveConnection, getOrgMcpKeys } from "@/lib/platform/controlPlane";
import { resolveMember, resolveOrgCtx, type CurrentUser } from "@/lib/platform/principal";
import type { OrgCtx } from "@/lib/platform/types";

export interface McpSession {
  ctx: OrgCtx;
  user: CurrentUser;
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

export async function resolveMcpSession(
  orgSlug: string,
  authorization: string | null,
): Promise<McpSessionResult> {
  const ctx = await resolveOrgCtx(orgSlug);
  if (!ctx) return { ok: false, status: 404, error: `Unknown organisation "${orgSlug}"` };

  const token = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim() ?? "";
  if (!token) return { ok: false, status: 401, error: "Missing bearer token" };

  const presented = hashMcpKey(token);
  const keys = await getOrgMcpKeys(orgSlug);
  const match = keys.find((k) => hashesEqual(k.keyHash, presented));
  if (!match) return { ok: false, status: 401, error: "Invalid API key" };

  if (!(await getActiveConnection(orgSlug, "mcp", "in"))) {
    return { ok: false, status: 403, error: "MCP access is not enabled for this organisation" };
  }

  const user = await resolveMember(ctx, match.memberEmail);
  if (!user) {
    return {
      ok: false,
      status: 403,
      error: "The member this key acts as is no longer active in this organisation",
    };
  }

  return { ok: true, session: { ctx, user } };
}
