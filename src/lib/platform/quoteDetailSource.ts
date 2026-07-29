// Quote detail data source — Postgres (default) or Airtable when the flag is
// on. Backs /app/[org]/quotes/[id] (edit meta, lines, lifecycle) and its
// printable view. id is a numeric PK in Postgres mode and a "rec…" record id in
// Airtable mode; the detail page's forms post that same id back and the quotes
// service is already RecordId-aware (see services/platform/construction/quotes).
//
// Airtable QUOTES is leaner than PlatConQuote — it has no createdAt/sentAt/
// decidedAt and JOBS carries no code/address/suburb — so those degrade to
// null/empty in Airtable mode. Lines live in QUOTE_LINES, filtered by their
// Quote link (Airtable can't filter linked records in a formula — match in app,
// fine at quote-line volumes), matching the quotes service's own read path.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { toNum } from "@/lib/format";
import { recordInScope } from "./rls";
import type { OrgCtx } from "./types";

export interface QuoteLineRow {
  id: string;
  description: string;
  category: string;
  qty: number;
  unit: string;
  unitPrice: number;
  lineTotal: number;
}

export interface QuoteDetailView {
  id: string;
  refNumber: string;
  title: string;
  status: string;
  clientName: string;
  validUntil: Date | null;
  gstRate: number;
  notes: string;
  subtotal: number;
  gstAmount: number;
  total: number;
  sentAt: Date | null;
  decidedAt: Date | null;
  createdAt: Date | null;
  /** Source assessment, when this quote is a proposal awaiting acceptance. */
  assessmentId: string | null;
  jobName: string;
  jobCode: string;
  jobAddress: string;
  jobSuburb: string;
  lines: QuoteLineRow[];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
function dateOrNull(v: unknown): Date | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
/** First linked record id in a linked-record cell, or null. */
function firstLink(v: unknown): string | null {
  return Array.isArray(v) && v.length ? String(v[0]) : null;
}
/** Whether a linked-record cell points at the given record id. */
function linksTo(v: unknown, recordId: string): boolean {
  return Array.isArray(v) && v.some((x) => String(x) === recordId);
}

async function fromPostgres(ctx: OrgCtx, id: string): Promise<QuoteDetailView | null> {
  const quoteId = Number(id);
  if (!Number.isInteger(quoteId)) return null;
  const quote = await db(ctx).platConQuote.findFirst({
    where: { id: quoteId, orgId: ctx.orgId },
    include: {
      job: { select: { name: true, code: true, address: true, suburb: true } },
      lines: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!quote) return null;
  if (!(await recordInScope(ctx, quote))) return null;
  // A proposal has no job yet (jobId/assessmentId carry the pre-acceptance state).
  return {
    id: String(quote.id),
    refNumber: quote.refNumber,
    title: quote.title,
    status: quote.status,
    clientName: quote.clientName,
    validUntil: quote.validUntil,
    gstRate: toNum(quote.gstRate),
    notes: quote.notes,
    subtotal: toNum(quote.subtotal),
    gstAmount: toNum(quote.gstAmount),
    total: toNum(quote.total),
    sentAt: quote.sentAt,
    decidedAt: quote.decidedAt,
    createdAt: quote.createdAt,
    assessmentId: quote.assessmentId != null ? String(quote.assessmentId) : null,
    jobName: quote.job?.name ?? "",
    jobCode: quote.job?.code ?? "",
    jobAddress: quote.job?.address ?? "",
    jobSuburb: quote.job?.suburb ?? "",
    lines: quote.lines.map((l) => ({
      id: String(l.id),
      description: l.description,
      category: l.category,
      qty: toNum(l.qty),
      unit: l.unit,
      unitPrice: toNum(l.unitPrice),
      lineTotal: toNum(l.lineTotal),
    })),
  };
}

async function fromAirtable(ctx: OrgCtx, id: string): Promise<QuoteDetailView | null> {
  if (!id.startsWith("rec")) return null;
  let quote;
  try {
    quote = await core.get(ctx.orgSlug, "QUOTES", id);
  } catch {
    return null; // 404 / deleted / wrong-base → not found
  }
  if (!(await recordInScope(ctx, quote))) return null;

  // Lines: read QUOTE_LINES and match on the Quote link in app (no formula
  // filtering on linked records), then sort by Sort_Order — mirrors the quotes
  // service's airtableQuoteLines helper.
  const lineRows = await core.list(ctx.orgSlug, "QUOTE_LINES", { maxRecords: 500 });
  const lines: QuoteLineRow[] = lineRows
    .filter((l) => linksTo(l["Quote"], id))
    .sort((a, b) => num(a["Sort_Order"]) - num(b["Sort_Order"]))
    .map((l) => ({
      id: l.id,
      description: str(l["Description"]) || "Line item",
      category: str(l["Category"]),
      qty: num(l["Qty"]),
      unit: str(l["Unit"]),
      unitPrice: num(l["Unit_Price"]),
      lineTotal: num(l["Line_Total"]),
    }));

  // Job is a leaner Airtable record — only its name is available (no code/
  // address). Resolve via the Quote's Job link; tolerate a missing/stale link.
  const jobRecId = firstLink(quote["Job"]);
  let jobName = "";
  if (jobRecId) {
    const job = await core.get(ctx.orgSlug, "JOBS", jobRecId).catch(() => null);
    jobName = job ? str(job["Job_Name"]) : "";
  }

  return {
    id: quote.id,
    refNumber: str(quote["Ref_Number"]),
    title: str(quote["Title"]) || "(untitled quote)",
    status: str(quote["Status"]) || "draft",
    clientName: str(quote["Client_Name"]),
    validUntil: dateOrNull(quote["Valid_Until"]),
    gstRate: num(quote["GST_Rate"]) || 10,
    notes: str(quote["Notes"]),
    subtotal: num(quote["Subtotal"]),
    gstAmount: num(quote["GST_Amount"]),
    total: num(quote["Total"]),
    sentAt: null, // not tracked on Airtable QUOTES
    decidedAt: null,
    createdAt: null,
    assessmentId: firstLink(quote["Assessment"]),
    jobName,
    jobCode: "", // Airtable JOBS has no code field (see plan P4)
    jobAddress: "",
    jobSuburb: "",
    lines,
  };
}

/** Load a single quote's detail view from whichever backend is active. */
export function loadQuoteDetail(ctx: OrgCtx, id: string): Promise<QuoteDetailView | null> {
  return airtableEnabled(ctx) ? fromAirtable(ctx, id) : fromPostgres(ctx, id);
}
