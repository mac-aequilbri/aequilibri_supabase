// Migration fan-out (§2b rule 6): apply schema changes to EVERY database in
// one operation — control DB first, then the shared/default tenant DB, then
// each provisioned per-org tenant DB from the control registry. A tenant DB
// with divergent schema is a defect, not a feature.
//
//   node scripts/migrate-all-tenants.mjs
//
// Fail-fast: the first failed deploy aborts the run (fix, re-run — deploys
// are idempotent). Re-applies each tenant's RLS org-pin afterwards so tables
// added by new migrations get pinned too.

import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";
import { applyTenantRlsPin } from "./_tenant-rls.mjs";
import { clearAutoEnabledRls } from "./_supabase.mjs";

// Supabase auto-enables policy-less RLS on tables new migrations create,
// default-denying the app role. Clear it after every deploy: wholesale on the
// non-org-pinned core DBs, non-org-tables-only on pinned tenant DBs (the pin
// re-applies right after). No-op on local databases.
async function clearRls(url, opts) {
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    const n = await clearAutoEnabledRls(client, opts);
    if (n) console.log(`   cleared auto-enabled RLS on ${n} tables`);
  } finally {
    await client.$disconnect();
  }
}

function deploy(label, opts) {
  console.log(`\n== migrate deploy: ${label}`);
  // Override BOTH URLs: with `directUrl` in the datasource the CLI migrates
  // via DIRECT_URL — overriding only DATABASE_URL would migrate the wrong DB.
  const res = spawnSync("npx", ["prisma", "migrate", "deploy", ...(opts.schema ? ["--schema", opts.schema] : [])], {
    env: { ...process.env, ...(opts.url ? { DATABASE_URL: opts.url, DIRECT_URL: opts.url } : {}) },
    stdio: "inherit",
    shell: true,
  });
  if (res.status !== 0) {
    console.error(`FAILED: ${label} — aborting fan-out (fix and re-run; deploys are idempotent).`);
    process.exit(1);
  }
}

// 1. Control DB.
deploy("control (CONTROL_DATABASE_URL)", { schema: "prisma/control/schema.prisma" });
await clearRls(process.env.CONTROL_DIRECT_URL || process.env.CONTROL_DATABASE_URL);

// 2. Shared/default tenant DB.
deploy("default tenant (DATABASE_URL)", {});
await clearRls(process.env.DIRECT_URL || process.env.DATABASE_URL);

// 3. Every provisioned per-org tenant DB, enumerated via the control registry
//    (§2b rule 7: cross-tenant operations iterate the registry, never a
//    hand-maintained list).
const controlDb = new ControlPrismaClient();
// ALL orgs, active or not: a deactivated org's database still exists and must
// stay schema-current so reactivation never meets a drifted schema.
const orgs = await controlDb.platOrganisation.findMany();
const summary = [];
for (const org of orgs) {
  let pooledUrl = null;
  let directUrl = null;
  try {
    const settings = JSON.parse(org.settings || "{}") || {};
    pooledUrl = settings.tenantDatabaseUrl || null;
    // Supabase entries carry a session-mode URL for CLI/ops work; legacy/local
    // entries (no pooler) fall back to the runtime URL.
    directUrl = settings.tenantDirectUrl || pooledUrl;
  } catch {
    /* malformed settings → treated as not provisioned */
  }
  if (!pooledUrl || pooledUrl === process.env.DATABASE_URL) continue;
  deploy(`tenant '${org.slug}'`, { url: directUrl });
  await clearRls(directUrl, { keepOrgIdTables: true });
  const client = new PrismaClient({ datasourceUrl: directUrl });
  const pinned = await applyTenantRlsPin(client, org.id);
  await client.$disconnect();
  summary.push({ org: org.slug, rlsPinnedTables: pinned });
}
await controlDb.$disconnect();

console.log(`\nFan-out complete: control + default + ${summary.length} provisioned tenant DB(s).`);
if (summary.length) console.table(summary);
