// Weekly logical backups (AWS plan §7): pg_dump EVERY database — control,
// default tenant, then each provisioned per-org tenant DB from the control
// registry (same enumeration as migrate-all-tenants.mjs, §2b rule 7) — and
// upload to the backups bucket. These per-database dumps are the per-tenant
// offboarding/restore artifact §2b promises; Supabase project backups can't
// restore one tenant in isolation.
//
//   node scripts/backup-all-tenants.mjs
//
// Env: BACKUPS_BUCKET (required), the four DB URLs (direct/session-mode URLs
// preferred — pg_dump over the transaction pooler is not supported).
// pg_dump client major must match the server (PG 17 → postgresql-client-17,
// installed in the Dockerfile's migrate/ops stage from PGDG).
//
// Fail-soft per database, fail-loud overall: one broken tenant doesn't stop
// the others, but any failure exits 1 and logs "BACKUP FAILED" — a CloudWatch
// metric filter alarms on that string.

import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";

const bucket = process.env.BACKUPS_BUCKET;
if (!bucket) {
  console.error("BACKUP FAILED: BACKUPS_BUCKET is unset");
  process.exit(1);
}

const s3 = new S3Client({});
const stamp = new Date().toISOString().replace(/[:]/g, "-").slice(0, 19); // 2026-08-14T09-00-00

async function dumpAndUpload(label, url) {
  console.log(`== pg_dump ${label}`);
  const file = join(tmpdir(), `${label}.dump`);
  // No shell: URLs contain characters a shell would mangle.
  const res = spawnSync("pg_dump", ["-Fc", "--no-owner", "--no-acl", "-f", file, url], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (res.status !== 0) throw new Error(`pg_dump exited ${res.status} for ${label}`);
  const size = (await stat(file)).size;
  const key = `pg/${label}/${stamp}.dump`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(file),
      ContentLength: size,
    }),
  );
  await rm(file, { force: true });
  const mb = +(size / 1024 / 1024).toFixed(2);
  console.log(`   s3://${bucket}/${key} (${mb} MB)`);
  return { label, key, mb };
}

// Same target set as the migration fan-out: control + default + registry.
const targets = [
  { label: "control", url: process.env.CONTROL_DIRECT_URL || process.env.CONTROL_DATABASE_URL },
  { label: "tenant-default", url: process.env.DIRECT_URL || process.env.DATABASE_URL },
];
const controlDb = new ControlPrismaClient();
const orgs = await controlDb.platOrganisation.findMany();
await controlDb.$disconnect();
for (const org of orgs) {
  try {
    const settings = JSON.parse(org.settings || "{}") || {};
    const direct = settings.tenantDirectUrl || settings.tenantDatabaseUrl || null;
    // Orgs on the shared/default DB are covered by the tenant-default dump.
    if (direct && settings.tenantDatabaseUrl !== process.env.DATABASE_URL) {
      targets.push({ label: `tenant-${org.slug}`, url: direct });
    }
  } catch {
    /* malformed settings → not provisioned → covered by default dump */
  }
}

const results = [];
const failures = [];
for (const t of targets) {
  if (!t.url) {
    failures.push(`${t.label} (no url)`);
    continue;
  }
  try {
    results.push(await dumpAndUpload(t.label, t.url));
  } catch (e) {
    console.error(String(e));
    failures.push(t.label);
  }
}

if (results.length) console.table(results);
if (failures.length) {
  console.error(`BACKUP FAILED for: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`Backup complete: ${results.length} database(s).`);
