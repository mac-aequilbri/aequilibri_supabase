import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { loadJobLabelMap } from "./jobOptionsSource";
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

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function dateOrNull(v: unknown): Date | null {
  const raw = str(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function linksTo(v: unknown, recordId: string): boolean {
  return Array.isArray(v) && v.some((x) => String(x) === recordId);
}

function firstLink(v: unknown): string | null {
  return Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
}

function docKindFrom(row: Record<string, unknown>): string {
  const kind = str(row["Kind"]);
  if (kind) return kind;
  const provider = str(row["Storage_Provider"]);
  if (provider === "conversation" || provider === "email") return "generated";
  return str(row["Drive_URL"]) ? "link" : "file";
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

async function fromAirtableList(ctx: OrgCtx): Promise<DocumentView[]> {
  const [rows, jobLabels] = await Promise.all([
    core.list(ctx.orgSlug, "DOCUMENTS", { maxRecords: 200 }),
    loadJobLabelMap(ctx),
  ]);
  return rows.map((r) => {
    const title = str(r["Document_Name"]) || "(untitled document)";
    const aiAnalysis = str(r["AI_Analysis"]) || "{}";
    const module2 = module2Meta({ title, aiAnalysis });
    const jobRec = firstLink(r["Job"]);
    const jobName = jobRec ? (jobLabels.get(jobRec) ?? null) : null;
    return {
      id: r.id,
      title,
      classification: str(r["Classification"]) || str(r["Document_Type"]),
      docType: str(r["Document_Type"]),
      kind: docKindFrom(r),
      storageRef: str(r["Drive_URL"]),
      storageProvider: str(r["Storage_Provider"]) || (str(r["Drive_URL"]) ? "gdrive" : "external"),
      status: str(r["Doc_Status"]) || str(r["Status"]) || "uploaded",
      createdAt: dateOrNull(r["Upload_Date"]),
      uploadedBy: str(r["Uploaded_By"]),
      aiSummary: str(r["AI_Summary"]),
      jobCode: null,
      jobName,
      jobId: jobRec,
      version: module2.version,
      lineageKey: module2.lineageKey,
    };
  });
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

async function fromAirtableDetail(ctx: OrgCtx, id: string): Promise<DocumentDetailView | null> {
  if (!id.startsWith("rec")) return null;
  const doc = await core.get(ctx.orgSlug, "DOCUMENTS", id).catch(() => null);
  if (!doc) return null;
  if (!(await recordInScope(ctx, doc))) return null;

  const title = str(doc["Document_Name"]) || "(untitled document)";
  const aiAnalysis = str(doc["AI_Analysis"]) || "{}";
  const module2 = module2Meta({ title, aiAnalysis });

  return {
    id: doc.id,
    title,
    classification: str(doc["Classification"]) || str(doc["Document_Type"]),
    docType: str(doc["Document_Type"]),
    kind: docKindFrom(doc),
    storageRef: str(doc["Drive_URL"]),
    storageProvider: str(doc["Storage_Provider"]) || "external",
    status: str(doc["Doc_Status"]) || str(doc["Status"]) || "uploaded",
    createdAt: dateOrNull(doc["Upload_Date"]),
    uploadedBy: str(doc["Uploaded_By"]),
    aiSummary: str(doc["AI_Summary"]),
    jobCode: null,
    jobName: null,
    jobId: firstLink(doc["Job"]),
    version: module2.version,
    lineageKey: module2.lineageKey,
    confidence: typeof doc["Confidence"] === "number" ? (doc["Confidence"] as number) : null,
    analyzedAt: dateOrNull(doc["Analyzed_At"]),
    textContent: str(doc["Text_Content"]),
    aiAnalysis,
    routeSuggestions: module2.routeSuggestions,
    immutableSnapshot: module2.immutableSnapshot,
    outputType: module2.outputType,
    contentHash: module2.contentHash,
    hashAlgo: module2.hashAlgo,
  };
}

export async function loadDocuments(ctx: OrgCtx): Promise<DocumentView[]> {
  const rows = await (airtableEnabled(ctx) ? fromAirtableList(ctx) : fromPostgresList(ctx));
  return scopeByJob(ctx, rows, (d) => d.jobId);
}

export function loadDocumentDetail(ctx: OrgCtx, id: string): Promise<DocumentDetailView | null> {
  return airtableEnabled(ctx) ? fromAirtableDetail(ctx, id) : fromPostgresDetail(ctx, id);
}

export async function findAirtableDocumentByJob(ctx: OrgCtx, jobId: string): Promise<DocumentView[]> {
  if (!airtableEnabled(ctx)) return [];
  const rows = await core.list(ctx.orgSlug, "DOCUMENTS", { maxRecords: 500 });
  return rows
    .filter((r) => linksTo(r["Job"], jobId))
    .map((r) => ({
      id: r.id,
      title: str(r["Document_Name"]) || "(untitled document)",
      classification: str(r["Classification"]) || str(r["Document_Type"]),
      docType: str(r["Document_Type"]),
      kind: docKindFrom(r),
      storageRef: str(r["Drive_URL"]),
      storageProvider: str(r["Storage_Provider"]) || (str(r["Drive_URL"]) ? "gdrive" : "external"),
      status: str(r["Doc_Status"]) || str(r["Status"]) || "uploaded",
      createdAt: dateOrNull(r["Upload_Date"]),
      uploadedBy: str(r["Uploaded_By"]),
      aiSummary: str(r["AI_Summary"]),
      jobCode: null,
      jobName: null,
      jobId,
      version: module2Meta({ title: str(r["Document_Name"]) || "(untitled document)", aiAnalysis: str(r["AI_Analysis"]) || "{}" }).version,
      lineageKey: module2Meta({ title: str(r["Document_Name"]) || "(untitled document)", aiAnalysis: str(r["AI_Analysis"]) || "{}" }).lineageKey,
    }));
}
