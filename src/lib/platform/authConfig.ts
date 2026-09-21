// Auth activation switches — shared by proxy (edge), layout, and org-context,
// so this module must stay free of Prisma/node-only imports.
//
// Provider: Supabase Auth on the control project (AU residency — owner
// decision 2026-09-21, docs/auth-supabase-migration-plan.md; replaced Clerk).
// Auth activates when BOTH public values are present (a single one set is
// treated as misconfiguration, not demo mode). Without them the platform
// fails CLOSED in production: /app/* returns 503 unless ALLOW_DEMO_MODE=true
// is set explicitly. Open demo mode is therefore always a deliberate
// decision, never the result of a missing or mistyped env var.
//
// NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time, so
// these switches are build-time constants in any given image — the layout
// tree's shape must never differ between prerender and runtime (the Clerk
// provider crash of 2026-09-21).

export function authEnabled(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/** Exactly one of the two public values set — almost certainly a deployment mistake. */
export function authMisconfigured(): boolean {
  return (
    !!process.env.NEXT_PUBLIC_SUPABASE_URL !== !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

/** May the platform run unauthenticated? In local dev/test: yes. Anywhere
 *  else — including a deployment whose NODE_ENV is unset or mistyped — only
 *  with the explicit ALLOW_DEMO_MODE=true opt-in, and never when auth is
 *  half-configured. (Keying on === "development" rather than !== "production"
 *  means a misconfigured production box fails closed, not open.) */
export function demoModeAllowed(): boolean {
  if (authMisconfigured()) return false;
  const env = process.env.NODE_ENV;
  if (env === "development" || env === "test") return true;
  return process.env.ALLOW_DEMO_MODE === "true";
}

/** Platform operators allowed to provision new customer organisations when
 *  auth is active (comma-separated emails). In demo mode provisioning is
 *  open by definition of the demo. */
export function platformAdminEmails(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}
