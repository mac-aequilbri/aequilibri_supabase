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

function deploy(label, opts) {
  console.log(`\n== migrate deploy: ${label}`);
  const res = spawnSync("npx", ["prisma", "migrate", "deploy", ...(opts.schema ? ["--schema", opts.schema] : [])], {
    env: { ...process.env, ...(opts.url ? { DATABASE_URL: opts.url } : {}) },
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

// 2. Shared/default tenant DB.
deploy("default tenant (DATABASE_URL)", {});

// 3. Every provisioned per-org tenant DB, enumerated via the control registry
//    (§2b rule 7: cross-tenant operations iterate the registry, never a
//    hand-maintained list).
const controlDb = new ControlPrismaClient();
const orgs = await controlDb.platOrganisation.findMany({ where: { isActive: true } });
const summary = [];
for (const org of orgs) {
  let url = null;
  try {
    url = JSON.parse(org.settings || "{}")?.tenantDatabaseUrl || null;
  } catch {
    /* malformed settings → treated as not provisioned */
  }
  if (!url || url === process.env.DATABASE_URL) continue;
  deploy(`tenant '${org.slug}'`, { url });
  const client = new PrismaClient({ datasourceUrl: url });
  const pinned = await applyTenantRlsPin(client, org.id);
  await client.$disconnect();
  summary.push({ org: org.slug, rlsPinnedTables: pinned });
}
await controlDb.$disconnect();

console.log(`\nFan-out complete: control + default + ${summary.length} provisioned tenant DB(s).`);
if (summary.length) console.table(summary);
