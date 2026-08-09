// MCP OAuth resource-server support (mcp-assistant-plan W4) — the token side
// of human MCP consumers (Claude Desktop/Code). This app is the RESOURCE
// server only: the authorization server is external and env-configured —
// Clerk's OAuth provider at go-live (it speaks MCP's OAuth 2.1 profile,
// including dynamic client registration), but nothing here is Clerk-specific:
// any OIDC authorization server with a userinfo endpoint works.
//
//   MCP_OAUTH_ISSUER        — AS base URL (e.g. https://clerk.<domain>).
//                             Unset = OAuth disabled; API keys keep working.
//   MCP_OAUTH_USERINFO_URL  — override; defaults to <issuer>/oauth/userinfo.
//
// A presented access token is resolved to the holder's EMAIL via userinfo,
// then the session pipeline applies the same walls as API keys: active
// mcp:in connection (kill switch) and active org membership (role + RLS).
// The token itself grants nothing an org hasn't granted the member.

import { createHash } from "node:crypto";
import { logger, errMeta } from "@/lib/logger";

export function oauthIssuer(): string | null {
  const raw = (process.env.MCP_OAUTH_ISSUER ?? "").trim().replace(/\/+$/, "");
  return raw || null;
}

export function oauthEnabled(): boolean {
  return oauthIssuer() !== null;
}

function userinfoUrl(): string | null {
  const override = (process.env.MCP_OAUTH_USERINFO_URL ?? "").trim();
  if (override) return override;
  const issuer = oauthIssuer();
  return issuer ? `${issuer}/oauth/userinfo` : null;
}

// Userinfo round-trips are cached briefly per token so a burst of MCP
// messages costs one AS call, while revocation still bites within a minute.
const CACHE_TTL_MS = 60_000;
const CACHE_CAP = 200;
const cache = new Map<string, { email: string | null; expiresAt: number }>();

/** Resolve an OAuth access token to the holder's email via the AS's userinfo
 *  endpoint. Null = invalid/expired token, no email claim, or AS unreachable
 *  (fail closed). */
export async function resolveOAuthEmail(token: string): Promise<string | null> {
  const url = userinfoUrl();
  if (!url) return null;

  const key = createHash("sha256").update(token, "utf8").digest("hex");
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.email;

  let email: string | null = null;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const claims = (await res.json()) as { email?: unknown };
      email =
        typeof claims.email === "string" && claims.email.includes("@")
          ? claims.email.toLowerCase()
          : null;
    }
  } catch (err) {
    logger.warn("MCP OAuth userinfo lookup failed", errMeta(err));
    return null; // fail closed, and don't cache transport errors
  }

  cache.set(key, { email, expiresAt: Date.now() + CACHE_TTL_MS });
  if (cache.size > CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return email;
}
