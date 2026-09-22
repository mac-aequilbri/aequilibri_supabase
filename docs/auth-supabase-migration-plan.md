# Auth migration: Clerk → Supabase Auth (AU residency)

**Status:** DONE — decided 2026-09-21, deployed same day, verified and Clerk
decommissioned 2026-09-22. Owner verified email/password and Google OAuth
sign-in end-to-end (Google via a Workspace-internal GCP OAuth client;
provider config in the Supabase dashboard). B-auth-5 executed: CLERK task
env, terraform variable, and the CLERK_SECRET_KEY secret removed (7-day
recovery window); owner deletes the Clerk application in their dashboard.
Production gotcha found during verification: route-handler redirects built
from `request.url` emit the container's internal hostname behind the ALB —
/auth/confirm issues RELATIVE Location headers instead.
**Driver:** hard AU data-residency requirement. Clerk processes user PII in
the US with no AU region (flagged in aws-deployment-plan §8 from the start).
Supabase Auth runs inside our existing **Sydney** projects — auth PII becomes
AU-resident with no new vendor.

**Scope decisions (owner, 2026-09-21):**
- Residency scope is **auth only, for now**. The other two §8 offshore
  processors — Anthropic API (US; AU alternative = Bedrock Sydney) and
  n8n Cloud (EU; AU alternative = self-hosted on ECS) — stay as-is pending
  client sign-off.
- **MCP human-OAuth is deferred.** Supabase Auth is not an OAuth
  authorization server (no dynamic client registration), so it cannot take
  Clerk's planned role as the MCP issuer. MCP goes live on its per-org API
  keys (W6: rate limits, metering, revocation). If human MCP OAuth is later
  required, add a dedicated OIDC issuer (Auth0 AU region or self-hosted
  Keycloak) — the resource server is issuer-agnostic (userinfo-based,
  `MCP_OAUTH_USERINFO_URL` override already exists).

**Why now is cheap:** exactly one registered user (the owner). No user
migration, no session migration, no comms. This window closes when Didi's
team gets accounts.

---

## 1. Target design

- **Identity host:** the `aequilibri-control` Supabase project (Sydney).
  Users are platform-wide (control-plane concern), same as the org registry.
  Per-client tenant projects never host auth.
- **Sign-in methods:** email + password with email confirmation at launch.
  (Google OAuth optional later — needs a Google Cloud OAuth app; owner call.)
- **Session model:** `@supabase/ssr` cookie sessions, refreshed in the proxy
  (middleware) per the Supabase Next.js SSR pattern.
- **Authorization unchanged:** membership stays email-keyed
  (`PlatCtlTeamMember`), operator gate stays `PLATFORM_ADMIN_EMAILS`. Only
  the *authentication* provider changes; `getAuthEmail()` remains the seam.
- **Env contract:**
  - `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` — public by
    design (client-exposed); build args + task env, mirroring the Clerk
    publishable-key plumbing.
  - `SUPABASE_SERVICE_ROLE_KEY` (control project) — server-only secret in
    AWS Secrets Manager; used for admin operations (user invites) only.
    NEVER in client env; it bypasses RLS.
- **Fail-closed semantics preserved:** authConfig keeps the same shape —
  fully configured → auth on; half-configured → misconfigured (503 on
  platform routes); nothing + `ALLOW_DEMO_MODE=true` → open demo. The
  build/runtime tree-shape lesson from the Clerk crash (2026-09-21) carries
  over: the root layout stays `force-dynamic`, and any provider gating must
  key on build-time-constant env only.

## 2. Code seams (verified call sites, 2026-09-21)

| Seam | Today (Clerk) | Target (Supabase Auth) |
|---|---|---|
| `src/proxy.ts` | `clerkMiddleware` + `auth.protect()` on /app, /uc1 | `@supabase/ssr` session refresh; unauthenticated → redirect `/sign-in?redirect_url=…` |
| `src/lib/platform/authConfig.ts` | `clerkEnabled/clerkMisconfigured/demoModeAllowed` | same functions, Supabase env underneath (URL + anon key) |
| `src/lib/platform/org-context.ts` `getAuthEmail()` | `currentUser()?.primaryEmailAddress` | server client `auth.getUser()` → `user.email` |
| `src/app/layout.tsx` | `ClerkProvider` + `Show` + `UserButton` | no provider needed; small client `UserMenu` (email + sign-out) shown when a session exists |
| `src/app/sign-in`, `src/app/sign-up` | `<SignIn/>`, `<SignUp/>` | hand-rolled forms on the existing design system (`supabase.auth.signInWithPassword` / `signUp`), honouring `redirect_url` |
| `src/app/(platform)/app/new/actions.ts`, `src/lib/platform/provisioning.ts` | `clerkClient` (invites) | `auth.admin.inviteUserByEmail` via service-role key |
| MCP OAuth (W4 routes/tests) | Clerk issuer assumed | feature-flagged off (issuer env unset → API-keys only); tests keep mocked issuer |
| Dockerfile / deploy.yml / infra task env | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` build-arg + env | replace with the two `NEXT_PUBLIC_SUPABASE_*` values |

Dependencies: add `@supabase/supabase-js` + `@supabase/ssr`; remove
`@clerk/nextjs` once cutover is verified.

## 3. Sequence

1. **B-auth-1:** enable Supabase Auth on the control project (email/password,
   confirmations on, Site URL = https://app.aequilibri.com, redirect URLs).
2. **B-auth-2:** code swap per §2 on a dedicated branch off `main`;
   typecheck + vitest green (auth-path tests updated).
3. **B-auth-3:** env plumbing (build args, task env, Secrets Manager entry
   for the service-role key; Terraform).
4. **B-auth-4:** deploy → owner signs up (email confirm) → verify:
   /app gated, org picker + Didi workspace render, admin gate works,
   sign-out works, health `auth_config` green.
5. **B-auth-5:** decommission Clerk — remove dependency + env, delete the
   Clerk application, empty the two Clerk secrets in Secrets Manager,
   drop the dev-instance DNS-free issuer from the go-live checklist.
   §8 doc updated: auth processor = Supabase (AU). MCP go-live item changes
   from "Clerk OAuth issuer" to "API keys at launch; OIDC issuer TBD".

Estimate: 2–4 engineering days, dominated by B-auth-2 and honest
verification in B-auth-4.

## 4. Risks / notes

- Supabase Auth lives in the control project's `auth` schema — it is
  covered by Supabase's daily Pro backups, but our weekly `pg_dump` runs as
  a non-superuser and does NOT capture `auth` schema contents. Acceptable
  (users are re-invitable; memberships are ours), but say so in the runbook.
- The service-role key is the most powerful credential in the platform —
  Secrets Manager only, never NEXT_PUBLIC, never in the client bundle.
- Sign-in UI is now ours: keep it minimal (email, password, forgot-password
  via `resetPasswordForEmail`) — no need to rebuild Clerk's full widget.
- Clerk removal also removes the "Development mode" badge issue and the
  burned `sk_test` key — both close automatically at B-auth-5.
