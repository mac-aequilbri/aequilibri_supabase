import { db, prisma } from "@/lib/db";
import { recordInScope, scopeByJob } from "./rls";
import type { OrgCtx } from "./types";

export interface DocumentView {
  id: string;
  title: string;
  classification: string;
  docType: string;
  kind: string;
  storageRef: string;
  storageProvider: string;
  status: string;
  createdAt: Date | null;
  uploadedBy: string;
  aiSummary: string;
  jobCode: string | null;
  jobName: string | null;
  jobId: string | null;
  version: number;
  lineageKey: string;
}

export interface DocumentDetailView extends DocumentView {
  confidence: number | null;
  analyzedAt: Date | null;
  textContent: string;
  aiAnalysis: string;
  routeSuggestions: Array<{ table: string; summary: string; proposalId?: number | string; status?: string }>;
  immutableSnapshot: boolean;
  outputType: string;
  contentHash: string;
  hashAlgo: string;
}

function parseAnalysis(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function module2Meta(row: { title: string; aiAnalysis: string; version?: number }): {
  version: number;
  lineageKey: string;
  routeSuggestions: DocumentDetailView["routeSuggestions"];
  immutableSnapshot: boolean;
  outputType: string;
  contentHash: string;
  hashAlgo: string;
} {
  const parsed = parseAnalysis(row.aiAnalysis);
  const module2 = (parsed.module2 ?? {}) as Record<string, unknown>;
  const module4 = (parsed.module4 ?? {}) as Record<string, unknown>;
  return {
    version: typeof module2.version === "number" ? module2.version : (row.version ?? 1),
    lineageKey:
      typeof module2.lineageKey === "string"
        ? module2.lineageKey
        : row.title.toLowerCase().replace(/\s+/g, "-"),
    routeSuggestions: Array.isArray(module2.routeSuggestions)
      ? (module2.routeSuggestions as DocumentDetailView["routeSuggestions"])
      : [],
    immutableSnapshot: module4.immutableSnapshot === true,
    outputType: typeof module4.outputType === "string" ? module4.outputType : "",
    contentHash: typeof module4.contentHash === "string" ? module4.contentHash : "",
    hashAlgo: typeof module4.hashAlgo === "string" ? module4.hashAlgo : "",
  };
}

async function fromPostgresList(ctx: OrgCtx): Promise<DocumentView[]> {
  const docs = await db(ctx).platDocument.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { createdAt: "desc" },
    take: 2000,
    include: { job: { select: { code: true, name: true } } },
  });
  return docs.map((d) => ({
    id: String(d.id),
    title: d.title,
    classification: d.classification,
    docType: d.docType,
    kind: d.kind,
    storageRef: d.storageRef,
    storageProvider: d.storageProvider,
    status: d.status,
    createdAt: d.createdAt,
    uploadedBy: d.uploadedBy,
    aiSummary: d.aiSummary,
    jobCode: d.job?.code ?? null,
    jobName: d.job?.name ?? null,
    jobId: d.jobId != null ? String(d.jobId) : null,
    version: d.version,
    lineageKey: module2Meta({ title: d.title, aiAnalysis: d.aiAnalysis, version: d.version }).lineageKey,
  }));
}

async function fromPostgresDetail(ctx: OrgCtx, id: string): Promise<DocumentDetailView | null> {
  const docId = Number(id);
  if (!Number.isInteger(docId)) return null;
  const doc = await db(ctx).platDocument.findFirst({
    where: { id: docId, orgId: ctx.orgId },
    include: { job: { select: { code: true, name: true } } },
  });
  if (!doc) return null;
  if (!(await recordInScope(ctx, doc))) return null;
  return {
    id: String(doc.id),
    title: doc.title,
    classification: doc.classification,
    docType: doc.docType,
    kind: doc.kind,
    storageRef: doc.storageRef,
    storageProvider: doc.storageProvider,
    status: doc.status,
    createdAt: doc.createdAt,
    uploadedBy: doc.uploadedBy,
    aiSummary: doc.aiSummary,
    jobCode: doc.job?.code ?? null,
    jobName: doc.job?.name ?? null,
    jobId: doc.jobId != null ? String(doc.jobId) : null,
    version: doc.version,
    lineageKey: module2Meta({ title: doc.title, aiAnalysis: doc.aiAnalysis, version: doc.version }).lineageKey,
    confidence: doc.confidence,
    analyzedAt: doc.analyzedAt,
    textContent: doc.textContent,
    aiAnalysis: doc.aiAnalysis,
    routeSuggestions: module2Meta({ title: doc.title, aiAnalysis: doc.aiAnalysis, version: doc.version }).routeSuggestions,
    immutableSnapshot: module2Meta({ title: doc.title, aiAnalysis: doc.aiAnalysis, version: doc.version }).immutableSnapshot,
    outputType: module2Meta({ title: doc.title, aiAnalysis: doc.aiAnalysis, version: doc.version }).outputType,
    contentHash: module2Meta({ title: doc.title, aiAnalysis: doc.aiAnalysis, version: doc.version }).contentHash,
    hashAlgo: module2Meta({ title: doc.title, aiAnalysis: doc.aiAnalysis, version: doc.version }).hashAlgo,
  };
}

export async function loadDocuments(ctx: OrgCtx): Promise<DocumentView[]> {
  const rows = await fromPostgresList(ctx);
  return scopeByJob(ctx, rows, (d) => d.jobId);
}

export function loadDocumentDetail(ctx: OrgCtx, id: string): Promise<DocumentDetailView | null> {
  return fromPostgresDetail(ctx, id);
}

export async function findAirtableDocumentByJob(_ctx: OrgCtx, _jobId: string): Promise<DocumentView[]> {
  return [];
}
