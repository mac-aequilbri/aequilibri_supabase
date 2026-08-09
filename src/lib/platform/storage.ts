// DriveStorer interface (Platform Architecture doc: "drive storer with
// taxonomy"). Local filesystem implementation for dev/demo; a Google Drive
// adapter slots in behind the same interface later. Files live under
// var/storage/<orgSlug>/<top-folder>/<jobCode|org>/<type>/<name> (gitignored).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface StoredRef {
  /** Provider-relative reference persisted on PlatDocument.storageRef. */
  ref: string;
  provider: string;
}

export interface DriveStorer {
  provider: string;
  put(parts: {
    orgSlug: string;
    jobCode?: string;
    docType?: string;
    folderSegments?: string[];
    name: string;
  }, buf: Buffer): Promise<StoredRef>;
  get(ref: string): Promise<Buffer>;
}

const ROOT = path.join(process.cwd(), "var", "storage");

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._ -]+/g, "_").slice(0, 120) || "file";
}

class LocalFsStorer implements DriveStorer {
  provider = "local";

  async put(
    parts: { orgSlug: string; jobCode?: string; docType?: string; folderSegments?: string[]; name: string },
    buf: Buffer,
  ): Promise<StoredRef> {
    const rel = path.posix.join(
      safe(parts.orgSlug),
      ...(parts.folderSegments?.length
        ? parts.folderSegments.map((s) => safe(s))
        : [safe(parts.docType || "uncategorised")]),
      safe(parts.jobCode ?? "org"),
      `${Date.now()}-${safe(parts.name)}`,
    );
    const abs = path.join(ROOT, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    return { ref: rel, provider: this.provider };
  }

  async get(ref: string): Promise<Buffer> {
    const abs = path.resolve(ROOT, ref);
    // Containment check — refs come from the DB, but never trust path joins.
    // path.relative rejects both `..` escapes and prefix-collision siblings
    // (a bare startsWith(ROOT) would accept e.g. `var/storage-x`).
    const rel = path.relative(ROOT, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Invalid storage ref");
    }
    return readFile(abs);
  }
}

let localStorer: DriveStorer | null = null;
let driveStorer: DriveStorer | null = null;
let s3Storer: DriveStorer | null = null;

function local(): DriveStorer {
  if (!localStorer) localStorer = new LocalFsStorer();
  return localStorer;
}

function s3(): DriveStorer {
  // Lazy require keeps the AWS SDK out of every request that never stores.
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const mod = require("./s3storage") as typeof import("./s3storage");
  if (!s3Storer) s3Storer = new mod.S3Storer();
  return s3Storer;
}

/** Factory, env-driven (AWS plan B1): S3 when DOCUMENTS_BUCKET is set (the
 *  production store — container filesystems are ephemeral), else Google
 *  Drive when its service-account env is configured, else local filesystem
 *  for dev/demo. */
export function getStorer(): DriveStorer {
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const mod = require("./s3storage") as typeof import("./s3storage");
  if (mod.s3Enabled()) return s3();
  // Lazy require avoids a cycle (gdrive imports the interface from here).
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const gdrive = require("./gdrive") as typeof import("./gdrive");
  if (gdrive.gdriveEnabled()) {
    if (!driveStorer) driveStorer = new gdrive.GoogleDriveStorer();
    return driveStorer;
  }
  return local();
}

/** Resolve the storer that wrote a given document (downloads must work even
 *  after the default provider changes). */
export function getStorerFor(provider: string): DriveStorer {
  if (provider === "s3") return s3();
  if (provider === "gdrive") {
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const gdrive = require("./gdrive") as typeof import("./gdrive");
    if (!driveStorer) driveStorer = new gdrive.GoogleDriveStorer();
    return driveStorer;
  }
  return local();
}
