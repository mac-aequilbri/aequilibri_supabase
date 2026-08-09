// One-shot mover: var/storage → S3 (AWS plan B1). Dev/staging artifacts only —
// production starts on S3. Uploads every file under var/storage to
// DOCUMENTS_BUCKET preserving the relative path (plus DOCUMENTS_PREFIX), then
// with --update-refs repoints PlatDocument rows (storageProvider "local" →
// "s3", storageRef → the new full key) across the default tenant DB and every
// provisioned per-org database from the control registry.
//
//   node scripts/migrate-local-storage-to-s3.mjs [--dry-run] [--update-refs]
//
// Idempotent: uploads overwrite same-key objects; ref updates only touch rows
// still marked "local". Requires DOCUMENTS_BUCKET (+ AWS credentials via the
// default chain) and, for --update-refs, DATABASE_URL / CONTROL_DATABASE_URL.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const ROOT = path.join(process.cwd(), "var", "storage");
const dryRun = process.argv.includes("--dry-run");
const updateRefs = process.argv.includes("--update-refs");

const bucket = (process.env.DOCUMENTS_BUCKET ?? "").trim();
if (!bucket) {
  console.error("DOCUMENTS_BUCKET is not set.");
  process.exit(1);
}
let prefix = (process.env.DOCUMENTS_PREFIX ?? "").trim().replace(/^\/+/, "");
if (prefix && !prefix.endsWith("/")) prefix += "/";

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // no var/storage at all — nothing to move
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs);
    else if (e.isFile()) yield abs;
  }
}

const s3 = new S3Client({});
let uploaded = 0;
for await (const abs of walk(ROOT)) {
  const rel = path.relative(ROOT, abs).split(path.sep).join("/");
  const key = prefix + rel;
  if (dryRun) {
    console.log(`would upload ${rel} -> s3://${bucket}/${key}`);
  } else {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: await readFile(abs) }));
    console.log(`uploaded ${rel} -> s3://${bucket}/${key}`);
  }
  uploaded += 1;
}
console.log(`${dryRun ? "would upload" : "uploaded"} ${uploaded} file(s)`);

if (updateRefs) {
  const { PrismaClient } = await import("@prisma/client");
  const { PrismaClient: ControlPrismaClient } = await import("@prisma/control-client");

  /** Repoint local refs in one tenant database. */
  async function repoint(db, label) {
    const rows = await db.platDocument.findMany({
      where: { storageProvider: "local" },
      select: { id: true, orgId: true, storageRef: true },
    });
    let changed = 0;
    for (const row of rows) {
      if (!row.storageRef) continue;
      const key = prefix + row.storageRef.split(path.sep).join("/");
      if (dryRun) {
        console.log(`  would repoint doc ${row.id}: ${row.storageRef} -> ${key}`);
      } else {
        await db.platDocument.update({
          where: { id: row.id },
          data: { storageProvider: "s3", storageRef: key },
        });
      }
      changed += 1;
    }
    console.log(`- ${label}: ${changed} document ref(s) ${dryRun ? "would be" : ""} repointed`);
  }

  const control = new ControlPrismaClient();
  const defaultDb = new PrismaClient();
  try {
    await repoint(defaultDb, "default tenant DB");
    const orgs = await control.platOrganisation.findMany();
    for (const org of orgs) {
      let url;
      try {
        url = JSON.parse(org.settings || "{}").tenantDatabaseUrl;
      } catch {
        url = undefined;
      }
      if (!url || url === process.env.DATABASE_URL) continue;
      const tdb = new PrismaClient({ datasourceUrl: url });
      try {
        await repoint(tdb, `tenant DB (${org.slug})`);
      } finally {
        await tdb.$disconnect();
      }
    }
  } finally {
    await defaultDb.$disconnect();
    await control.$disconnect();
  }
}
