// Attachment binary export (migration-plan Phase 4.5). Airtable attachment
// URLs EXPIRE (~2h after issue), so binaries must be downloaded DURING the
// export, not later. READ-ONLY on the Airtable side.
//
//   node scripts/migration/download-attachments.mjs --org <slug> [--base appXXX]
//        [--dir var/attachments] [--apply-refs] [--limit N]
//
// What it does:
//   1. Lists DOCUMENTS rows in the org's base; for every `File` attachment,
//      downloads the binary to <dir>/<org>/<docRecId>/<n>-<filename>.
//   2. Writes <dir>/<org>/manifest.json — recordId → [{path, filename, mime,
//      size, airAttachmentId}] — the durable record of every binary.
//   3. With --apply-refs: updates the org's PlatDocument rows (matched by
//      airtableRecordId, in the org's tenant DB per §2b routing) with
//      storageProvider "local" + storageRef = the downloaded path, mime and
//      size — the app's document layer then serves them like any local file.
//      Multi-attachment records keep their FIRST file on the row; the rest
//      live in the manifest (logged).
//
// AU residency: this writes to the local filesystem; production runs sync
// <dir> to AU-resident object storage (S3 ap-southeast-2 etc.) and re-point
// storageProvider/storageRef accordingly (Phase 7 ops checklist). Downloading
// locally first is deliberate — the URLs expire too fast for a later pass.
//
// Idempotent: existing files are kept (size-checked), the manifest is
// rewritten, --apply-refs upserts the same values.

import { mkdirSync, existsSync, statSync, writeFileSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";
import { envVar, listAll } from "./_shared.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}
const org = arg("org");
const applyRefs = process.argv.includes("--apply-refs");
const limit = Number(arg("limit", "0")) || 0;
const outDir = arg("dir", "var/attachments");
if (!org) throw new Error("Usage: --org <slug> [--base appXXX] [--dir …] [--apply-refs] [--limit N]");
envVar("AIRTABLE_PAT");

const controlDb = new ControlPrismaClient();
const orgRow = await controlDb.platOrganisation.findUnique({ where: { slug: org } });
if (!orgRow) throw new Error(`No org '${org}' in the control registry.`);
const baseId = arg("base") ?? orgRow.airtableBaseId;
if (!baseId) throw new Error(`Org '${org}' has no airtableBaseId — pass --base.`);

const orgDir = path.join(outDir, org);
mkdirSync(orgDir, { recursive: true });

const rows = await listAll(baseId, "DOCUMENTS");
const manifest = {};
let files = 0, skipped = 0, bytes = 0;
const safe = (s) => String(s).replace(/[^\w.\-]+/g, "_").slice(0, 120);

for (const rec of rows) {
  const atts = Array.isArray(rec.fields["File"]) ? rec.fields["File"] : [];
  if (!atts.length) continue;
  const recDir = path.join(orgDir, rec.id);
  mkdirSync(recDir, { recursive: true });
  manifest[rec.id] = [];
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i];
    if (!a?.url) continue;
    const fname = `${i}-${safe(a.filename ?? "file")}`;
    const fpath = path.join(recDir, fname);
    const rel = path.relative(outDir, fpath).split(path.sep).join("/");
    if (existsSync(fpath) && a.size && statSync(fpath).size === a.size) {
      skipped++;
    } else {
      const res = await fetch(a.url);
      if (!res.ok) {
        console.log(`  ! ${rec.id}/${fname}: HTTP ${res.status} — skipped`);
        continue;
      }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(fpath));
      files++;
      bytes += statSync(fpath).size;
    }
    manifest[rec.id].push({
      path: rel,
      filename: a.filename ?? "file",
      mime: a.type ?? "",
      size: a.size ?? statSync(fpath).size,
      airAttachmentId: a.id ?? "",
    });
    if (limit && files >= limit) break;
  }
  if (limit && files >= limit) break;
}
writeFileSync(path.join(orgDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(
  `documents with attachments: ${Object.keys(manifest).length}; downloaded ${files} file(s), ` +
    `${skipped} already present, ${(bytes / 1024 / 1024).toFixed(1)} MB; manifest written.`,
);

if (applyRefs) {
  // §2b routing: rows live in the org's own tenant DB when provisioned.
  let targetUrl = null;
  try {
    targetUrl = JSON.parse(orgRow.settings || "{}")?.tenantDatabaseUrl || null;
  } catch {
    /* default */
  }
  const prisma = targetUrl ? new PrismaClient({ datasourceUrl: targetUrl }) : new PrismaClient();
  let applied = 0, multi = 0, missing = 0;
  for (const [recId, list] of Object.entries(manifest)) {
    if (!list.length) continue;
    const doc = await prisma.platDocument.findFirst({
      where: { orgId: orgRow.id, airtableRecordId: recId },
    });
    if (!doc) {
      missing++;
      continue;
    }
    await prisma.platDocument.update({
      where: { id: doc.id },
      data: {
        storageProvider: "local",
        storageRef: `attachments/${list[0].path}`,
        mimeType: list[0].mime.slice(0, 100),
        sizeBytes: list[0].size,
      },
    });
    applied++;
    if (list.length > 1) multi++;
  }
  console.log(
    `apply-refs: ${applied} PlatDocument rows updated, ${missing} without a migrated row ` +
      `(run airtable-to-pg first), ${multi} multi-attachment records (extras stay in the manifest).`,
  );
  await prisma.$disconnect();
}
await controlDb.$disconnect();
