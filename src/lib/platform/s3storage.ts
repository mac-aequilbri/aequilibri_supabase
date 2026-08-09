// S3 DriveStorer (AWS plan B1) — the production document store once the app
// runs on ECS. Auth comes from the default credential chain (task role in
// AWS, SSO/env locally), region from AWS_REGION; no keys in code or env.
//
//   DOCUMENTS_BUCKET — bucket name; setting it selects this provider.
//   DOCUMENTS_PREFIX — optional key prefix (e.g. "documents/").
//
// Stored refs are FULL object keys (prefix included), so changing the prefix
// later never breaks existing PlatDocument.storageRef values.

import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { DriveStorer, StoredRef } from "./storage";

export function s3Enabled(): boolean {
  return !!(process.env.DOCUMENTS_BUCKET ?? "").trim();
}

function bucket(): string {
  const b = (process.env.DOCUMENTS_BUCKET ?? "").trim();
  if (!b) throw new Error("DOCUMENTS_BUCKET is not configured");
  return b;
}

function prefix(): string {
  const p = (process.env.DOCUMENTS_PREFIX ?? "").trim().replace(/^\/+/, "");
  if (!p) return "";
  return p.endsWith("/") ? p : `${p}/`;
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._ -]+/g, "_").slice(0, 120) || "file";
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) client = new S3Client({});
  return client;
}

export class S3Storer implements DriveStorer {
  provider = "s3";

  async put(
    parts: { orgSlug: string; jobCode?: string; docType?: string; folderSegments?: string[]; name: string },
    buf: Buffer,
  ): Promise<StoredRef> {
    // Same taxonomy as LocalFsStorer so a bucket listing reads like the
    // var/storage tree: <org>/<folders|docType>/<jobCode|org>/<ts>-<name>.
    const key =
      prefix() +
      [
        safe(parts.orgSlug),
        ...(parts.folderSegments?.length
          ? parts.folderSegments.map((s) => safe(s))
          : [safe(parts.docType || "uncategorised")]),
        safe(parts.jobCode ?? "org"),
        `${Date.now()}-${safe(parts.name)}`,
      ].join("/");
    await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: buf }));
    return { ref: key, provider: this.provider };
  }

  async get(ref: string): Promise<Buffer> {
    // Refs come from the DB; S3 keys can't traverse, but reject shapes that
    // could only come from tampering.
    if (!ref || ref.startsWith("/") || ref.includes("..")) {
      throw new Error("Invalid storage ref");
    }
    const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: ref }));
    if (!res.Body) throw new Error("Empty S3 response body");
    return Buffer.from(await res.Body.transformToByteArray());
  }
}
