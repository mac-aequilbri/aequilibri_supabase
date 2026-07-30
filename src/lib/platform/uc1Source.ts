// UC1 (Roofing) data sources — Postgres. UC1 is single-tenant (no org). The
// ~40 Uc1* models all follow the same per-page loader pattern.

import { prisma } from "@/lib/db";

export interface Uc1ContactView {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  createdAt: Date | string | null;
  quotes: number;
}

export async function loadUc1Contacts(): Promise<Uc1ContactView[]> {
  const rows = await prisma.uc1Contact.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { quotes: true } } },
  });
  return rows.map((c) => ({
    id: String(c.id),
    name: c.name,
    email: c.email,
    phone: c.phone,
    company: c.company,
    createdAt: c.createdAt,
    quotes: c._count.quotes,
  }));
}

export interface Uc1RateCardView {
  id: string;
  material: string;
  pitchType: string;
  description: string;
  unit: string;
  rateExGst: number;
  isActive: boolean;
}

export async function loadUc1RateCards(): Promise<Uc1RateCardView[]> {
  const rows = await prisma.uc1RateCard.findMany({
    orderBy: [{ material: "asc" }, { pitchType: "asc" }],
  });
  return rows.map((c) => ({
    id: String(c.id),
    material: c.material,
    pitchType: c.pitchType,
    description: c.description,
    unit: c.unit,
    rateExGst: Number(c.rateExGst),
    isActive: c.isActive,
  }));
}

export interface Uc1FinanceProviderView {
  id: string;
  name: string;
  interestRatePct: number;
  minTermMonths: number;
  maxTermMonths: number;
  tagline: string;
  isActive: boolean;
}

export async function loadUc1FinanceProviders(): Promise<Uc1FinanceProviderView[]> {
  const rows = await prisma.uc1FinanceProvider.findMany({ orderBy: { name: "asc" } });
  return rows.map((p) => ({
    id: String(p.id),
    name: p.name,
    interestRatePct: Number(p.interestRatePct),
    minTermMonths: p.minTermMonths,
    maxTermMonths: p.maxTermMonths,
    tagline: p.tagline,
    isActive: p.isActive,
  }));
}

export interface Uc1GutteringRateView {
  id: string;
  itemType: string;
  description: string;
  rateExGst: number;
  unit: string;
  isActive: boolean;
}

export async function loadUc1GutteringRates(): Promise<Uc1GutteringRateView[]> {
  const rows = await prisma.uc1GutteringRate.findMany({ orderBy: { itemType: "asc" } });
  return rows.map((c) => ({
    id: String(c.id),
    itemType: c.itemType,
    description: c.description,
    rateExGst: Number(c.rateExGst),
    unit: c.unit,
    isActive: c.isActive,
  }));
}

export interface Uc1RegionView {
  id: string;
  name: string;
  postcodes: string;
  travelDays: number;
  travelRate: number;
  premiumPct: number;
  isActive: boolean;
}

export async function loadUc1Regions(): Promise<Uc1RegionView[]> {
  const rows = await prisma.uc1Region.findMany({ orderBy: { name: "asc" } });
  return rows.map((r) => ({
    id: String(r.id),
    name: r.name,
    postcodes: r.postcodes,
    travelDays: r.travelDays,
    travelRate: Number(r.travelRate),
    premiumPct: r.premiumPct,
    isActive: r.isActive,
  }));
}

export interface Uc1TeamMemberView {
  id: string;
  name: string;
  role: string;
  accuracyProfile: string;
  dateJoined: Date | string | null;
  isActive: boolean;
  corrections: number;
}

export async function loadUc1Team(): Promise<Uc1TeamMemberView[]> {
  const members = await prisma.uc1TeamMember.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  const counts = await prisma.uc1Correction.groupBy({
    by: ["estimatorId"],
    _count: { id: true },
    where: { estimatorId: { not: null } },
  });
  const byId: Record<number, number> = Object.fromEntries(
    counts.map((c) => [c.estimatorId as number, c._count.id]),
  );
  return members.map((m) => ({
    id: String(m.id),
    name: m.name,
    role: m.role,
    accuracyProfile: m.accuracyProfile,
    dateJoined: m.dateJoined,
    isActive: m.isActive,
    corrections: byId[m.id] ?? 0,
  }));
}

export interface Uc1SolarPartnerView {
  id: string;
  name: string;
  contactName: string;
  referralFeePct: number;
  avgInstallValue: number;
  isActive: boolean;
}

export async function loadUc1SolarPartners(): Promise<Uc1SolarPartnerView[]> {
  const rows = await prisma.uc1SolarPartner.findMany({ orderBy: { name: "asc" } });
  return rows.map((p) => ({
    id: String(p.id),
    name: p.name,
    contactName: p.contactName,
    referralFeePct: Number(p.referralFeePct),
    avgInstallValue: Number(p.avgInstallValue),
    isActive: p.isActive,
  }));
}

export interface Uc1WorkstreamView {
  id: string;
  name: string;
  description: string;
  milestone: string;
  status: string;
  loadAtSessionStart: boolean;
  lastUpdated: Date | string | null;
}

export async function loadUc1Workstreams(): Promise<Uc1WorkstreamView[]> {
  const rows = await prisma.uc1Workstream.findMany({
    orderBy: [{ status: "asc" }, { lastUpdated: "desc" }],
  });
  return rows.map((w) => ({
    id: String(w.id),
    name: w.name,
    description: w.description,
    milestone: w.milestone,
    status: w.status,
    loadAtSessionStart: w.loadAtSessionStart,
    lastUpdated: w.lastUpdated,
  }));
}

export interface Uc1PriceCheckLogView {
  id: string;
  runAt: Date | string | null;
  status: string;
  vendorsChecked: number;
  pricesUpdated: number;
  pricesUnchanged: number;
  errors: number;
  summary: string;
}

export interface Uc1PriceMovementView {
  id: string;
  description: string;
  unitPriceExGst: number;
  previousPrice: number | null;
  updatedAt: Date | string | null;
  vendor: { name: string };
}

export async function loadUc1PriceCheck(): Promise<{
  logs: Uc1PriceCheckLogView[];
  recentChanges: Uc1PriceMovementView[];
}> {
  const [logRows, priceRows] = await Promise.all([
    prisma.uc1PriceCheckLog.findMany({ orderBy: { runAt: "desc" }, take: 50 }),
    prisma.uc1VendorMaterialPrice.findMany({
      where: { previousPrice: { not: null } },
      include: { vendor: { select: { name: true } } },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
  ]);
  return {
    logs: logRows.map((l) => ({
      id: String(l.id),
      runAt: l.runAt,
      status: l.status,
      vendorsChecked: l.vendorsChecked,
      pricesUpdated: l.pricesUpdated,
      pricesUnchanged: l.pricesUnchanged,
      errors: l.errors,
      summary: l.summary,
    })),
    recentChanges: priceRows.map((p) => ({
      id: String(p.id),
      description: p.description,
      unitPriceExGst: Number(p.unitPriceExGst),
      previousPrice: p.previousPrice == null ? null : Number(p.previousPrice),
      updatedAt: p.updatedAt,
      vendor: { name: p.vendor.name },
    })),
  };
}

export interface Uc1ActionView {
  id: string;
  action: string;
  priority: string;
  dueDate: Date | null;
  triggerCondition: string;
  status: string;
  notes: string;
}

export async function loadUc1Actions(): Promise<Uc1ActionView[]> {
  const rows = await prisma.uc1ActionHub.findMany({
    orderBy: [{ priority: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
  });
  return rows.map((a) => ({
    id: String(a.id),
    action: a.action,
    priority: a.priority,
    dueDate: a.dueDate,
    triggerCondition: a.triggerCondition,
    status: a.status,
    notes: a.notes,
  }));
}

export interface Uc1ExecLogView {
  id: string;
  toolName: string;
  status: string;
  durationMs: number;
  createdAt: Date | string | null;
}

export async function loadUc1ExecLog(): Promise<Uc1ExecLogView[]> {
  const rows = await prisma.uc1ExecutionLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, toolName: true, status: true, durationMs: true, createdAt: true },
  });
  return rows.map((r) => ({
    id: String(r.id),
    toolName: r.toolName,
    status: r.status,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
  }));
}

export interface Uc1IntelSnapshotView {
  accuracyRatePct: number;
  completedJobs: number;
  avgConfidence: number;
  confidenceTrajectory: string;
  gapsJson: string;
}
export interface Uc1IntelCorrectionView {
  id: string;
  dimension: string;
  suburb: string;
  aiValue: number;
  humanValue: number;
  variancePct: number;
  rootCause: string;
  createdAt: Date | string | null;
}
export interface Uc1IntelHypothesisView {
  id: string;
  description: string;
  sampleCount: number;
  avgVariancePct: number;
  confidence: number;
  status: string;
}
export interface Uc1IntelRuleView {
  id: string;
  ruleCode: string;
  category: string;
  description: string;
  triggerCondition: string;
  priority: number;
  confidence: number;
  timesTriggered: number;
  isActive: boolean;
  autoApply: boolean;
}
export interface Uc1QuoteRow {
  id: string;
  refNumber: string;
  propertyAddress: string;
  status: string;
  createdAt: Date | string | null;
  contactName: string | null;
  total: number;
}

const GST = 1.1;

/** Quotes list with totals, computed from line items. Returns
 *  `connected:false` on DB error to match the page's existing behaviour. */
export async function loadUc1Quotes(
  status: string,
): Promise<{ connected: boolean; rows: Uc1QuoteRow[] }> {
  try {
    const where = status && status !== "all" ? { status } : {};
    const quotes = await prisma.uc1Quote.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: { items: true, contact: true },
    });
    return {
      connected: true,
      rows: quotes.map((q) => ({
        id: String(q.id),
        refNumber: q.refNumber,
        propertyAddress: q.propertyAddress,
        status: q.status,
        createdAt: q.createdAt,
        contactName: q.contact?.name ?? null,
        total:
          Math.round(
            q.items.reduce((s, i) => s + Number(i.quantity) * Number(i.unitPriceExGst), 0) *
              GST *
              100,
          ) / 100,
      })),
    };
  } catch {
    return { connected: false, rows: [] };
  }
}

function incGst(n: number): number {
  return Math.round(n * GST * 100) / 100;
}

export interface Uc1ConditionReportView {
  id: string;
  reportNumber: string;
  clientName: string;
  grade: string;
  urgency: string;
  status: string;
  price: number;
  generatedAt: Date | string | null;
}

export async function loadUc1ConditionReports(): Promise<Uc1ConditionReportView[]> {
  const reports = await prisma.uc1RoofConditionReport.findMany({ orderBy: { generatedAt: "desc" } });
  return reports.map((r) => ({
    id: String(r.id),
    reportNumber: r.reportNumber,
    clientName: r.clientName,
    grade: r.conditionGrade,
    urgency: r.urgencyLevel,
    status: r.status,
    price: incGst(Number(r.priceExGst)),
    generatedAt: r.generatedAt,
  }));
}

export interface Uc1PurchaseOrderView {
  id: string;
  poNumber: string;
  vendor: string;
  status: string;
  createdAt: Date | string | null;
  total: number;
}

export async function loadUc1PurchaseOrders(): Promise<Uc1PurchaseOrderView[]> {
  const pos = await prisma.uc1PurchaseOrder.findMany({
    orderBy: { createdAt: "desc" },
    include: { vendor: true, poItems: true },
  });
  return pos.map((p) => ({
    id: String(p.id),
    poNumber: p.poNumber,
    vendor: p.vendor.name,
    status: p.status,
    createdAt: p.createdAt,
    total: incGst(p.poItems.reduce((s, i) => s + Number(i.quantity) * Number(i.unitPriceExGst), 0)),
  }));
}

export interface Uc1StormEventView {
  id: string;
  name: string;
  eventType: string;
  eventDate: Date | string | null;
  state: string;
  leads: number;
}

export async function loadUc1StormEvents(): Promise<Uc1StormEventView[]> {
  const events = await prisma.uc1StormEvent.findMany({
    orderBy: { eventDate: "desc" },
    include: { _count: { select: { leads: true } } },
  });
  return events.map((e) => ({
    id: String(e.id),
    name: e.name,
    eventType: e.eventType,
    eventDate: e.eventDate,
    state: e.state,
    leads: e._count.leads,
  }));
}

export interface Uc1StormLeadView {
  id: string;
  address: string;
  suburb: string;
  roofAreaSqm: number;
  estimatedValue: number;
  contactName: string;
  contactPhone: string;
  status: string;
}
export interface Uc1StormDetail {
  id: string;
  name: string;
  eventType: string;
  severity: number;
  eventDate: Date | string | null;
  affectedSuburbs: string;
  leads: Uc1StormLeadView[];
}

export async function loadUc1StormEvent(id: string): Promise<Uc1StormDetail | null> {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const e = await prisma.uc1StormEvent
    .findUnique({ where: { id: n }, include: { leads: { orderBy: { createdAt: "desc" } } } })
    .catch(() => null);
  if (!e) return null;
  return {
    id: String(e.id),
    name: e.name,
    eventType: e.eventType,
    severity: e.severity,
    eventDate: e.eventDate,
    affectedSuburbs: e.affectedSuburbs,
    leads: e.leads.map((l) => ({
      id: String(l.id),
      address: l.address,
      suburb: l.suburb,
      roofAreaSqm: Number(l.roofAreaSqm),
      estimatedValue: Number(l.estimatedValue),
      contactName: l.contactName,
      contactPhone: l.contactPhone,
      status: l.status,
    })),
  };
}

export interface Uc1MeasurementSnapshotView {
  id: string;
  address: string;
  totalAreaM2: number;
  sectionCount: number;
  storeys: number;
  snapshotType: string;
  createdAt: Date | string | null;
  quote: { id: string; refNumber: string } | null;
}
export interface Uc1QuoteSnapshotView {
  id: string;
  address: string;
  roofType: string;
  totalIncGst: number;
  createdAt: Date | string | null;
  quote: { id: string; refNumber: string } | null;
}

export async function loadUc1MeasurementHistory(query: string): Promise<{
  snapshots: Uc1MeasurementSnapshotView[];
  quoteSnapshots: Uc1QuoteSnapshotView[];
}> {
  const where = query ? { OR: [{ address: { contains: query } }] } : {};
  const [snaps, qsnaps] = await Promise.all([
    prisma.uc1MeasurementSnapshot.findMany({
      where,
      include: { quote: { select: { id: true, refNumber: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.uc1QuoteSnapshot.findMany({
      where,
      include: { quote: { select: { id: true, refNumber: true } } },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  return {
    snapshots: snaps.map((s) => ({
      id: String(s.id),
      address: s.address,
      totalAreaM2: Number(s.totalAreaM2),
      sectionCount: s.sectionCount,
      storeys: s.storeys,
      snapshotType: s.snapshotType,
      createdAt: s.createdAt,
      quote: s.quote ? { id: String(s.quote.id), refNumber: s.quote.refNumber } : null,
    })),
    quoteSnapshots: qsnaps.map((s) => ({
      id: String(s.id),
      address: s.address,
      roofType: s.roofType,
      totalIncGst: Number(s.totalIncGst),
      createdAt: s.createdAt,
      quote: s.quote ? { id: String(s.quote.id), refNumber: s.quote.refNumber } : null,
    })),
  };
}

export interface Uc1QuoteItemView {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  unitPriceExGst: number;
  sortOrder: number;
}
export interface Uc1QuoteDetail {
  id: string;
  refNumber: string;
  propertyAddress: string;
  status: string;
  material: string;
  pitchType: string;
  wasteFactorPct: number;
  flatAreaSqm: number;
  pricingMechanism: string;
  pricingMode: string;
  packageTier: string;
  notes: string;
  roofPolygonJson: string;
  ridgeLm: number;
  eaveLm: number;
  valleyLm: number;
  hipLm: number;
  rakeLm: number;
  pitchDegActual: number;
  storeys: number;
  roofColour: string;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  contact: { name: string; company: string; email: string; phone: string } | null;
  items: Uc1QuoteItemView[];
}

export async function loadUc1Quote(id: string): Promise<Uc1QuoteDetail | null> {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const q = await prisma.uc1Quote
    .findUnique({
      where: { id: n },
      include: { items: { orderBy: { sortOrder: "asc" } }, contact: true },
    })
    .catch(() => null);
  if (!q) return null;
  return {
    id: String(q.id),
    refNumber: q.refNumber,
    propertyAddress: q.propertyAddress,
    status: q.status,
    material: q.material,
    pitchType: q.pitchType,
    wasteFactorPct: Number(q.wasteFactorPct),
    flatAreaSqm: Number(q.flatAreaSqm),
    pricingMechanism: q.pricingMechanism,
    pricingMode: q.pricingMode,
    packageTier: q.packageTier,
    notes: q.notes,
    roofPolygonJson: q.roofPolygonJson ?? "",
    ridgeLm: Number(q.ridgeLm),
    eaveLm: Number(q.eaveLm),
    valleyLm: Number(q.valleyLm),
    hipLm: Number(q.hipLm),
    rakeLm: Number(q.rakeLm),
    pitchDegActual: Number(q.pitchDegActual),
    storeys: q.storeys,
    roofColour: q.roofColour,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    contact: q.contact
      ? {
          name: q.contact.name,
          company: q.contact.company,
          email: q.contact.email,
          phone: q.contact.phone,
        }
      : null,
    items: q.items.map((i) => ({
      id: String(i.id),
      description: i.description,
      quantity: Number(i.quantity),
      unit: i.unit,
      unitPriceExGst: Number(i.unitPriceExGst),
      sortOrder: i.sortOrder,
    })),
  };
}

export interface Uc1PoDetail {
  id: string;
  poNumber: string;
  vendor: string;
  status: string;
  deliveryAddress: string;
  requestedDeliveryDate: Date | string | null;
  notes: string;
  createdAt: Date | string | null;
  items: Uc1QuoteItemView[];
}

export async function loadUc1PurchaseOrder(id: string): Promise<Uc1PoDetail | null> {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const po = await prisma.uc1PurchaseOrder
    .findUnique({
      where: { id: n },
      include: { vendor: true, poItems: { orderBy: { sortOrder: "asc" } } },
    })
    .catch(() => null);
  if (!po) return null;
  return {
    id: String(po.id),
    poNumber: po.poNumber,
    vendor: po.vendor.name,
    status: po.status,
    deliveryAddress: po.deliveryAddress,
    requestedDeliveryDate: po.requestedDeliveryDate,
    notes: po.notes,
    createdAt: po.createdAt,
    items: po.poItems.map((i) => ({
      id: String(i.id),
      description: i.description,
      quantity: Number(i.quantity),
      unit: i.unit,
      unitPriceExGst: Number(i.unitPriceExGst),
      sortOrder: i.sortOrder,
    })),
  };
}

export interface Uc1ConditionReportDetail {
  id: string;
  reportNumber: string;
  conditionGrade: string;
  conditionScore: number;
  lifeRemainingYears: number;
  urgencyLevel: string;
  aiAssessment: string;
  recommendedWorks: string;
  status: string;
  reportType: string;
  clientName: string;
  inspectorName: string;
  priceExGst: number;
  generatedAt: Date | string | null;
  quote: { id: string; refNumber: string; propertyAddress: string } | null;
}

export async function loadUc1ConditionReport(id: string): Promise<Uc1ConditionReportDetail | null> {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const r = await prisma.uc1RoofConditionReport
    .findUnique({
      where: { id: n },
      include: { quote: { select: { id: true, refNumber: true, propertyAddress: true } } },
    })
    .catch(() => null);
  if (!r) return null;
  return {
    id: String(r.id),
    reportNumber: r.reportNumber,
    conditionGrade: r.conditionGrade,
    conditionScore: r.conditionScore,
    lifeRemainingYears: r.lifeRemainingYears,
    urgencyLevel: r.urgencyLevel,
    aiAssessment: r.aiAssessment,
    recommendedWorks: r.recommendedWorks,
    status: r.status,
    reportType: r.reportType,
    clientName: r.clientName,
    inspectorName: r.inspectorName,
    priceExGst: Number(r.priceExGst),
    generatedAt: r.generatedAt,
    quote: r.quote
      ? { id: String(r.quote.id), refNumber: r.quote.refNumber, propertyAddress: r.quote.propertyAddress }
      : null,
  };
}

export interface Uc1IntelligenceData {
  snapshot: Uc1IntelSnapshotView | null;
  corrections: Uc1IntelCorrectionView[];
  hypotheses: Uc1IntelHypothesisView[];
  rules: Uc1IntelRuleView[];
}

export async function loadUc1Intelligence(): Promise<Uc1IntelligenceData> {
  const [snap, corrections, hypotheses, rules] = await Promise.all([
    prisma.uc1IntelligenceSnapshot.findFirst({ orderBy: { capturedAt: "desc" } }),
    prisma.uc1Correction.findMany({ orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.uc1Hypothesis.findMany({ orderBy: { confidence: "desc" } }),
    prisma.uc1LearningRule.findMany({ orderBy: [{ isActive: "desc" }, { confidence: "desc" }] }),
  ]);
  return {
    snapshot: snap
      ? {
          accuracyRatePct: snap.accuracyRatePct,
          completedJobs: snap.completedJobs,
          avgConfidence: snap.avgConfidence,
          confidenceTrajectory: snap.confidenceTrajectory,
          gapsJson: snap.gapsJson,
        }
      : null,
    corrections: corrections.map((c) => ({
      id: String(c.id),
      dimension: c.dimension,
      suburb: c.suburb,
      aiValue: c.aiValue,
      humanValue: c.humanValue,
      variancePct: c.variancePct,
      rootCause: c.rootCause,
      createdAt: c.createdAt,
    })),
    hypotheses: hypotheses.map((h) => ({
      id: String(h.id),
      description: h.description,
      sampleCount: h.sampleCount,
      avgVariancePct: h.avgVariancePct,
      confidence: h.confidence,
      status: h.status,
    })),
    rules: rules.map((r) => ({
      id: String(r.id),
      ruleCode: r.ruleCode,
      category: r.category,
      description: r.description,
      triggerCondition: r.triggerCondition,
      priority: r.priority,
      confidence: r.confidence,
      timesTriggered: r.timesTriggered,
      isActive: r.isActive,
      autoApply: r.autoApply,
    })),
  };
}
