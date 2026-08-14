// Provision a client org's own tenant database (§2b, Supabase edition): one
// Supabase PROJECT per client org — created via the Management API — replaces
// the old same-server CREATE DATABASE. The Postgres analogue of Airtable
// template-base cloning; ops script, migration-plan Phase 3 stage B3.
//
//   node scripts/provision-tenant-db.mjs --slug <org> [--project-name <name>]
//        [--db-password <pw>] [--activate]
//
// Requires SUPABASE_ACCESS_TOKEN + SUPABASE_ORG_ID (ops-only env).
//
// Steps:
//   1. Find-or-create Supabase project `aequilibri-t-<slug>` in ap-southeast-2
//      and wait until ACTIVE_HEALTHY. A fresh project generates a db password
//      (PRINTED ONCE — store it); reusing an existing project requires
//      --db-password (the Management API cannot read it back).
//   2. Bootstrap the runtime role `aequilibri_app` (NOBYPASSRLS; re-keyed on
//      every run) with DML grants + default privileges.
//   3. Full tenant migration history via `prisma migrate deploy` over the
//      session-mode pooler URL (both DATABASE_URL and DIRECT_URL overridden —
//      the CLI migrates via directUrl now that the schema declares one).
//   4. Native RLS pin for the org (scripts/_tenant-rls.mjs), applied as
//      postgres; it binds the app role, which cannot bypass RLS.
//   5. With --activate: store BOTH URLs in the org's registry settings —
//      settings.tenantDatabaseUrl  (transaction pooler :6543, aequilibri_app,
//                                   ?pgbouncer=true — what db(ctx) uses)
//      settings.tenantDirectUrl    (session pooler :5432, postgres — what
//                                   migrate fan-out / pg_dump use)
//
// --activate is a SEPARATE, deliberate step: do not activate before the
// prisma.* → db(ctx) call-site sweep is complete AND the org's rows have
// been copied into the new database — a premature flip splits reads/writes.
//
// Idempotent: an existing project is reused (migrate deploy is a no-op on an
// up-to-date DB; the RLS pin and role bootstrap re-apply).

import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";
import { applyTenantRlsPin } from "./_tenant-rls.mjs";
import {
  createProject,
  findProjectByName,
  waitForHealthy,
  poolerHost,
  pooledAppUrl,
  sessionAdminUrl,
  bootstrapAppRole,
  clearAutoEnabledRls,
  generatePassword,
} from "./_supabase.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const slug = arg("slug");
const activate = process.argv.includes("--activate");
if (!slug) {
  console.error(
    "Usage: node scripts/provision-tenant-db.mjs --slug <org> [--project-name <name>] [--db-password <pw>] [--activate]",
  );
  process.exit(1);
}

const controlDb = new ControlPrismaClient();
const org = await controlDb.platOrganisation.findUnique({ where: { slug } });
if (!org) throw new Error(`No org with slug '${slug}' in the control registry.`);

// 1. Find-or-create the per-org Supabase project.
const projectName = arg("project-name", `aequilibri-t-${slug.replace(/[^a-z0-9-]/g, "-")}`);
let dbPassword = arg("db-password", process.env.SUPABASE_DB_PASSWORD || null);
let project = await findProjectByName(projectName);
if (project) {
  console.log(`- project '${projectName}' already exists (ref ${project.id})`);
  if (!dbPassword) {
    throw new Error(
      `Reusing an existing project requires --db-password (the Management API cannot read the postgres password back).`,
    );
  }
} else {
  dbPassword = dbPassword || generatePassword();
  project = await createProject({ name: projectName, dbPass: dbPassword });
  console.log(`- created project '${projectName}' (ref ${project.id})`);
  console.log(`  db password (postgres role) — STORE THIS NOW, it is not retrievable: ${dbPassword}`);
}
project = await waitForHealthy(project.id);
const host = await poolerHost(project.id);
const sessionUrl = sessionAdminUrl({ host, ref: project.id, dbPassword });

// 2. Runtime role (re-keyed each run; the pooled URL below carries the new password).
const appPassword = generatePassword();
const admin = new PrismaClient({ datasourceUrl: sessionUrl });
await bootstrapAppRole(admin, appPassword);
console.log(`- bootstrapped role aequilibri_app (NOBYPASSRLS verified)`);

// 3. Tenant migration history (override BOTH: the CLI migrates via directUrl).
const dep = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  env: { ...process.env, DATABASE_URL: sessionUrl, DIRECT_URL: sessionUrl },
  stdio: "inherit",
  shell: true,
});
if (dep.status !== 0) throw new Error(`migrate deploy failed for project ${projectName}`);

// 4. Native RLS pin (§2b rule 4). First clear Supabase's auto-enabled
// policy-less RLS from non-org tables (default-denies the app role); the pin
// then re-enables RLS WITH the org_pin policy on every org_id table.
const cleared = await clearAutoEnabledRls(admin, { keepOrgIdTables: true });
if (cleared) console.log(`- cleared auto-enabled RLS on ${cleared} non-org tables`);
const pinned = await applyTenantRlsPin(admin, org.id);
await admin.$disconnect();
console.log(`- RLS org_pin (org_id = ${org.id}) applied to ${pinned} tables`);

const tenantUrl = pooledAppUrl({ host, ref: project.id, appPassword });

// 5. Activation (deliberate, separate).
if (activate) {
  let settings = {};
  try {
    const parsed = JSON.parse(org.settings || "{}");
    if (parsed && typeof parsed === "object") settings = parsed;
  } catch {
    /* start from empty */
  }
  settings.tenantDatabaseUrl = tenantUrl;
  settings.tenantDirectUrl = sessionUrl;
  await controlDb.platOrganisation.update({
    where: { id: org.id },
    data: { settings: JSON.stringify(settings) },
  });
  console.log(`- ACTIVATED: settings.tenantDatabaseUrl set — db(ctx) now routes '${slug}' to ${projectName}`);
} else {
  console.log(`- not activated (pass --activate after the data copy + call-site sweep)`);
  console.log(`  runtime (pooled) url: ${tenantUrl}`);
  console.log(`  ops (session) url:    ${sessionUrl}`);
}
await controlDb.$disconnect();
console.log("done.");
