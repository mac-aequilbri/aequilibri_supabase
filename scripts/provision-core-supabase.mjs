// One-off ops script (AWS/Supabase plan Phase 2): stand up the two CORE
// Supabase projects — `aequilibri-control` (control-plane DB) and
// `aequilibri-t-default` (shared/default tenant DB) — bootstrap the runtime
// role in each, run the matching migration history, and print the four URLs
// destined for AWS Secrets Manager:
//
//   aequilibri-t-default → DATABASE_URL (pooled) + DIRECT_URL (session)
//   aequilibri-control   → CONTROL_DATABASE_URL (pooled) + CONTROL_DIRECT_URL (session)
//
//   node scripts/provision-core-supabase.mjs [--db-password-control <pw>] [--db-password-default <pw>]
//
// Requires SUPABASE_ACCESS_TOKEN + SUPABASE_ORG_ID (ops-only env). Passwords
// are required only when reusing existing projects (the Management API cannot
// read them back); fresh projects generate and PRINT them once.
//
// No RLS pin here: the control DB is not org-pinned, and the default tenant
// DB is multi-org (the constant org_pin only fits single-org tenant DBs).
// Registry activation does not apply — these URLs live in env/Secrets Manager.
//
// Idempotent: existing projects are reused; role bootstrap re-keys; migrate
// deploy is a no-op on an up-to-date DB.

import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import {
  createProject,
  findProjectByName,
  waitForHealthy,
  poolerHost,
  pooledAppUrl,
  sessionAdminUrl,
  bootstrapAppRole,
  generatePassword,
} from "./_supabase.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}

async function standUp({ name, dbPassword, schema }) {
  console.log(`\n== ${name}`);
  let project = await findProjectByName(name);
  if (project) {
    console.log(`- project exists (ref ${project.id})`);
    if (!dbPassword) throw new Error(`Reusing '${name}' requires its db password (see --db-password-* flags).`);
  } else {
    dbPassword = dbPassword || generatePassword();
    project = await createProject({ name, dbPass: dbPassword });
    console.log(`- created (ref ${project.id})`);
    console.log(`  db password (postgres role) — STORE THIS NOW, it is not retrievable: ${dbPassword}`);
  }
  project = await waitForHealthy(project.id);
  const host = await poolerHost(project.id);
  const sessionUrl = sessionAdminUrl({ host, ref: project.id, dbPassword });

  const appPassword = generatePassword();
  const admin = new PrismaClient({ datasourceUrl: sessionUrl });
  await bootstrapAppRole(admin, appPassword);
  await admin.$disconnect();
  console.log(`- bootstrapped role aequilibri_app (NOBYPASSRLS verified)`);

  const dep = spawnSync(
    "npx",
    ["prisma", "migrate", "deploy", ...(schema ? ["--schema", schema] : [])],
    {
      env: {
        ...process.env,
        DATABASE_URL: sessionUrl,
        DIRECT_URL: sessionUrl,
        CONTROL_DATABASE_URL: sessionUrl,
        CONTROL_DIRECT_URL: sessionUrl,
      },
      stdio: "inherit",
      shell: true,
    },
  );
  if (dep.status !== 0) throw new Error(`migrate deploy failed for ${name}`);

  return { pooled: pooledAppUrl({ host, ref: project.id, appPassword }), session: sessionUrl };
}

const def = await standUp({
  name: "aequilibri-t-default",
  dbPassword: arg("db-password-default"),
  schema: null, // tenant schema (prisma/schema.prisma)
});
const ctl = await standUp({
  name: "aequilibri-control",
  dbPassword: arg("db-password-control"),
  schema: "prisma/control/schema.prisma",
});

console.log(`\n== Secrets Manager values (app task needs the two pooled URLs; migrate task needs all four)`);
console.log(`DATABASE_URL=${def.pooled}`);
console.log(`DIRECT_URL=${def.session}`);
console.log(`CONTROL_DATABASE_URL=${ctl.pooled}`);
console.log(`CONTROL_DIRECT_URL=${ctl.session}`);
console.log("\ndone.");
