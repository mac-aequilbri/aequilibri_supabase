// Clear Supabase's auto-enabled, policy-less RLS from a database's public
// tables (it default-denies the aequilibri_app role — every write fails with
// 42501). Provisioning and migrate fan-out do this automatically; this
// standalone script covers one-off cases: after a pg_restore, or repairing a
// project bootstrapped before this step existed.
//
//   node scripts/supabase-clear-auto-rls.mjs --session-url <url> [--keep-org-tables]
//   node scripts/supabase-clear-auto-rls.mjs --env DIRECT_URL [--keep-org-tables]
//
// --keep-org-tables: leave org_id tables alone (per-client tenant DBs, where
// scripts/_tenant-rls.mjs owns their RLS state). Core control/default DBs
// carry no native RLS by design (§2b) — omit the flag there.

import { PrismaClient } from "@prisma/client";
import { clearAutoEnabledRls } from "./_supabase.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}

const envName = arg("env");
const url = arg("session-url") || (envName ? process.env[envName] : null);
if (!url) {
  console.error("Usage: node scripts/supabase-clear-auto-rls.mjs (--session-url <url> | --env <VAR>) [--keep-org-tables]");
  process.exit(1);
}
const keepOrgIdTables = process.argv.includes("--keep-org-tables");

const client = new PrismaClient({ datasourceUrl: url });
const n = await clearAutoEnabledRls(client, { keepOrgIdTables });
await client.$disconnect();
console.log(`cleared auto-enabled RLS on ${n} tables${keepOrgIdTables ? " (org_id tables kept)" : ""}`);
