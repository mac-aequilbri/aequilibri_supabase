// Quote detail data source — Postgres. Backs /app/[org]/quotes/[id] (edit
// meta, lines, lifecycle) and its printable view. id is a numeric PK; the
// detail page's forms post that same id back (see
// services/platform/construction/quotes).

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

/** Load a single quote's detail view. */
export function loadQuoteDetail(ctx: OrgCtx, id: string): Promise<QuoteDetailView | null> {
  return fromPostgres(ctx, id);
}
