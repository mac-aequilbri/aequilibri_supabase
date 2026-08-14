// Bootstrap an EXISTING Supabase project (created by hand in the dashboard,
// no Management API token needed) into a §2b database: runtime role +
// migration history, then print the URL pair for env/Secrets Manager or
// registry activation.
//
//   node scripts/supabase-bootstrap-existing.mjs --session-url <url>
//        [--schema prisma/control/schema.prisma]
//
// --session-url is the SESSION-mode pooler URL as the postgres role:
//   postgresql://postgres.<ref>:<db-password>@aws-N-<region>.pooler.supabase.com:5432/postgres
// (never the db.<ref>.supabase.co host — IPv6-only). Default schema is the
// tenant schema; pass --schema for the control project.
//
// Steps: bootstrap `aequilibri_app` (NOBYPASSRLS, re-keyed each run) →
// `prisma migrate deploy` (both env URLs overridden) → print the pooled
// runtime URL (:6543, ?pgbouncer=true) + the session URL.
//
// No RLS pin and no registry activation here — for per-client tenant DBs use
// provision-tenant-db.mjs (Management API) or apply scripts/_tenant-rls.mjs
// and activate manually.

import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { bootstrapAppRole, clearAutoEnabledRls, generatePassword, APP_ROLE } from "./_supabase.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}

const sessionUrl = arg("session-url");
const schema = arg("schema");
if (!sessionUrl) {
  console.error("Usage: node scripts/supabase-bootstrap-existing.mjs --session-url <url> [--schema <path>]");
  process.exit(1);
}
const parsed = new URL(sessionUrl);
const [role, ref] = parsed.username.split(".");
if (role !== "postgres" || !ref || parsed.port !== "5432") {
  throw new Error("Expected a session-mode pooler URL: postgres.<ref> on port 5432");
}
if (/\.supabase\.co$/.test(parsed.hostname) && parsed.hostname.startsWith("db.")) {
  throw new Error("That is the direct db.<ref> host (IPv6-only) — use the pooler host from the dashboard's Connect panel");
}

// 1. Runtime role (re-keyed each run; the printed pooled URL carries the new password).
const appPassword = generatePassword();
const admin = new PrismaClient({ datasourceUrl: sessionUrl });
await bootstrapAppRole(admin, appPassword);
console.log(`- bootstrapped role ${APP_ROLE} (NOBYPASSRLS verified)`);

// 2. Migration history (override BOTH pairs: the CLI migrates via directUrl).
const dep = spawnSync("npx", ["prisma", "migrate", "deploy", ...(schema ? ["--schema", schema] : [])], {
  env: {
    ...process.env,
    DATABASE_URL: sessionUrl,
    DIRECT_URL: sessionUrl,
    CONTROL_DATABASE_URL: sessionUrl,
    CONTROL_DIRECT_URL: sessionUrl,
  },
  stdio: "inherit",
  shell: true,
});
if (dep.status !== 0) throw new Error("migrate deploy failed");

// 3. Supabase auto-enables policy-less RLS on new public tables, which
// default-denies the app role. Core (non-org-pinned) databases carry no
// native RLS by design (§2b) — clear it.
const cleared = await clearAutoEnabledRls(admin);
await admin.$disconnect();
console.log(`- cleared auto-enabled RLS on ${cleared} tables`);

const pooled = new URL(sessionUrl);
pooled.port = "6543";
pooled.username = `${APP_ROLE}.${ref}`;
pooled.password = encodeURIComponent(appPassword);
pooled.search = "?pgbouncer=true&connection_limit=5";

console.log(`\nruntime (pooled) url: ${pooled.toString()}`);
console.log(`ops (session) url:    ${sessionUrl}`);
console.log("done.");
