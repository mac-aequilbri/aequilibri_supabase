// Provision a client org's own tenant database (§2b: CREATE DATABASE +
// migrate + RLS pin — the Postgres analogue of Airtable template-base
// cloning). Ops script; migration-plan Phase 3 stage B3.
//
//   node scripts/provision-tenant-db.mjs --slug <org> [--db-name <name>] [--activate]
//
// Steps:
//   1. CREATE DATABASE (name defaults to aequilibri_t_<slug>) on the same
//      server as DATABASE_URL.
//   2. Full tenant migration history via `prisma migrate deploy`.
//   3. Native RLS pin for the org (scripts/_tenant-rls.mjs).
//   4. With --activate: store the URL in the org's registry settings
//      (settings.tenantDatabaseUrl) so db(ctx) routes to it.
//
// --activate is a SEPARATE, deliberate step: do not activate before the
// prisma.* → db(ctx) call-site sweep is complete AND the org's rows have
// been copied into the new database — a premature flip splits reads/writes.
//
// Idempotent: an existing database is reused (migrate deploy is a no-op on
// an up-to-date DB; the RLS pin re-applies).

import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";
import { applyTenantRlsPin } from "./_tenant-rls.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const slug = arg("slug");
const activate = process.argv.includes("--activate");
if (!slug) {
  console.error("Usage: node scripts/provision-tenant-db.mjs --slug <org> [--db-name <name>] [--activate]");
  process.exit(1);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is unset");

const controlDb = new ControlPrismaClient();
const org = await controlDb.platOrganisation.findUnique({ where: { slug } });
if (!org) throw new Error(`No org with slug '${slug}' in the control registry.`);

const dbName = arg("db-name", `aequilibri_t_${slug.replace(/[^a-z0-9_]/g, "_")}`);
if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error(`Bad database name: ${dbName}`);
const url = new URL(process.env.DATABASE_URL);
url.pathname = `/${dbName}`;
const tenantUrl = url.toString();

// 1. CREATE DATABASE (cannot run in a transaction; tolerate "already exists").
const admin = new PrismaClient(); // connected to the default tenant DB
try {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
  console.log(`- created database ${dbName}`);
} catch (err) {
  if (/already exists/i.test(String(err.message))) console.log(`- database ${dbName} already exists`);
  else throw err;
} finally {
  await admin.$disconnect();
}

// 2. Tenant migration history.
const dep = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  env: { ...process.env, DATABASE_URL: tenantUrl },
  stdio: "inherit",
  shell: true,
});
if (dep.status !== 0) throw new Error(`migrate deploy failed for ${dbName}`);

// 3. Native RLS pin (§2b rule 4).
const tenant = new PrismaClient({ datasourceUrl: tenantUrl });
const pinned = await applyTenantRlsPin(tenant, org.id);
await tenant.$disconnect();
console.log(`- RLS org_pin (org_id = ${org.id}) applied to ${pinned} tables`);

// 4. Activation (deliberate, separate).
if (activate) {
  let settings = {};
  try {
    const parsed = JSON.parse(org.settings || "{}");
    if (parsed && typeof parsed === "object") settings = parsed;
  } catch {
    /* start from empty */
  }
  settings.tenantDatabaseUrl = tenantUrl;
  await controlDb.platOrganisation.update({
    where: { id: org.id },
    data: { settings: JSON.stringify(settings) },
  });
  console.log(`- ACTIVATED: settings.tenantDatabaseUrl set — db(ctx) now routes '${slug}' to ${dbName}`);
} else {
  console.log(`- not activated (pass --activate after the data copy + call-site sweep)`);
  console.log(`  tenant url: ${tenantUrl}`);
}
await controlDb.$disconnect();
console.log("done.");
