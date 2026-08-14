// Supabase Management API helpers (owner decision 2026-08-13: Supabase
// replaces direct/RDS Postgres; one Supabase project per client org keeps the
// §2b database-per-client topology).
//
// Shared by scripts/provision-tenant-db.mjs and scripts/provision-core-supabase.mjs.
// Requires ops-only env (never app runtime env):
//   SUPABASE_ACCESS_TOKEN — personal access token for the Management API
//   SUPABASE_ORG_ID       — the Supabase organisation id (Pro org, Sydney)
//
// Connection-string contract (§2b amendment):
//   runtime  → Supavisor TRANSACTION mode, port 6543, role aequilibri_app,
//              ?pgbouncer=true&connection_limit=5   (prepared statements off)
//   CLI/ops  → Supavisor SESSION mode, port 5432, role postgres
//              (migrate deploy, RLS pin, pg_dump). Never the db.<ref> host:
//              it is IPv6-only without the IPv4 add-on.
//
// Role model: Supabase's built-in `postgres` role (can bypass RLS) is the
// admin/migrator; `aequilibri_app` (NOBYPASSRLS NOCREATEDB NOCREATEROLE) is
// the ONLY role in runtime URLs, so the org_pin RLS tripwire stays real.

import { randomBytes } from "node:crypto";

const API = "https://api.supabase.com";
export const SUPABASE_REGION = "ap-southeast-2"; // AU residency (owner decision)
export const APP_ROLE = "aequilibri_app";

function accessToken() {
  const t = process.env.SUPABASE_ACCESS_TOKEN;
  if (!t) throw new Error("SUPABASE_ACCESS_TOKEN is unset (ops-only env — see docs/aws-deployment-plan.md)");
  return t;
}

export function requiredOrgId() {
  const id = process.env.SUPABASE_ORG_ID;
  if (!id) throw new Error("SUPABASE_ORG_ID is unset (ops-only env)");
  return id;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Management API ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.status === 204 ? null : res.json();
}

export function generatePassword() {
  // base64url: URL-safe, no percent-encoding needed in connection strings.
  return randomBytes(24).toString("base64url");
}

export async function findProjectByName(name) {
  const projects = await api("/v1/projects");
  const orgId = requiredOrgId();
  return projects.find((p) => p.organization_id === orgId && p.name === name) || null;
}

// Create a project (region pinned to Sydney). Returns the API's project
// object; `.id` is the project ref used in hosts and pooler usernames.
export async function createProject({ name, dbPass }) {
  return api("/v1/projects", {
    method: "POST",
    body: {
      organization_id: requiredOrgId(),
      name,
      region: SUPABASE_REGION,
      db_pass: dbPass,
    },
  });
}

// New projects take ~1-2 min to come up. Poll politely (Management API rate
// limit is ~60 req/min across all callers).
export async function waitForHealthy(ref, { timeoutMs = 10 * 60_000, intervalMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = await api(`/v1/projects/${ref}`);
    if (p.status === "ACTIVE_HEALTHY") return p;
    if (Date.now() > deadline) throw new Error(`Project ${ref} not healthy after ${timeoutMs / 1000}s (status: ${p.status})`);
    console.log(`  … project ${ref} status ${p.status}, waiting`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Supavisor pooler host. Prefer the API's own answer; fall back to the
// documented regional pattern only if the endpoint shape changes.
export async function poolerHost(ref) {
  try {
    const configs = await api(`/v1/projects/${ref}/config/database/pooler`);
    const entry = Array.isArray(configs)
      ? configs.find((c) => c.database_type === "PRIMARY") || configs[0]
      : configs;
    if (entry?.db_host) return entry.db_host;
    if (entry?.connection_string) return new URL(entry.connection_string.replace(/^postgres(ql)?:/, "http:")).hostname;
  } catch (err) {
    console.warn(`  ! pooler config endpoint failed (${err.message}); using regional default host`);
  }
  return `aws-0-${SUPABASE_REGION}.pooler.supabase.com`;
}

// Runtime URL: transaction-mode pooler, app role, prepared statements off.
export function pooledAppUrl({ host, ref, appPassword }) {
  return `postgresql://${APP_ROLE}.${ref}:${encodeURIComponent(appPassword)}@${host}:6543/postgres?pgbouncer=true&connection_limit=5`;
}

// CLI/ops URL: session-mode pooler, postgres role.
export function sessionAdminUrl({ host, ref, dbPassword }) {
  return `postgresql://postgres.${ref}:${encodeURIComponent(dbPassword)}@${host}:5432/postgres`;
}

// Create (or re-key) the runtime role and grant it DML on public. Runs as
// `postgres` over the session URL. ALTER DEFAULT PRIVILEGES makes future
// migrations (also run as postgres) auto-grant new tables/sequences.
export async function bootstrapAppRole(adminClient, appPassword) {
  const pw = appPassword.replace(/'/g, "''");
  await adminClient.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${pw}';
      ELSE
        ALTER ROLE ${APP_ROLE} LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${pw}';
      END IF;
    END
    $$;
  `);
  for (const sql of [
    `GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE}`,
  ]) {
    await adminClient.$executeRawUnsafe(sql);
  }
  await assertAppRoleCannotBypassRls(adminClient);
}

// Supabase auto-enables RLS (with no policies = default-deny) on every table
// created in `public` — including Prisma-migrated ones. For the app role that
// silently blocks ALL writes. Clear it wholesale; org-pinned tenant DBs get
// their RLS re-enabled with a policy by scripts/_tenant-rls.mjs afterwards.
// Idempotent and harmless on databases with no RLS enabled (local dev).
export async function clearAutoEnabledRls(adminClient, { keepOrgIdTables = false } = {}) {
  const rows = await adminClient.$queryRawUnsafe(`
    SELECT c.relname AS table
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
      AND NOT (${keepOrgIdTables ? "true" : "false"} AND EXISTS (
        SELECT 1 FROM information_schema.columns col
        WHERE col.table_schema = 'public' AND col.table_name = c.relname
          AND col.column_name = 'org_id'
      ))
  `);
  for (const { table } of rows) {
    await adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
    await adminClient.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
  }
  return rows.length;
}

// The whole point of the two-role split: a runtime role that RLS applies to.
export async function assertAppRoleCannotBypassRls(adminClient) {
  const rows = await adminClient.$queryRawUnsafe(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = '${APP_ROLE}'`,
  );
  const r = rows[0];
  if (!r) throw new Error(`${APP_ROLE} role does not exist`);
  if (r.rolbypassrls || r.rolsuper) {
    throw new Error(`${APP_ROLE} can bypass RLS (rolbypassrls=${r.rolbypassrls}, rolsuper=${r.rolsuper}) — org_pin would be inert`);
  }
}
