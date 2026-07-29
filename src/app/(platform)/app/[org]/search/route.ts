// Org-scoped global search backing the ⌘K palette. Every query is filtered by
// orgId (the tenancy guard enforces this), so search can never cross tenants,
// and each job-linked group is filtered to the viewer's job scope (§3/§7 RLS)
// so hits can't disclose records on unassigned projects. Vendors stay
// org-global. Returns a small, typed, grouped result set the client renders.

import { NextRequest, NextResponse } from "next/server";
import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { VARIATION_FILTER } from "@/lib/platform/changeLog";
import { requireOrgCtx } from "@/lib/platform/org-context";
import { listOptional } from "@/lib/platform/optionalList";
import { orgPath } from "@/lib/platform/paths";
import { currentJobScope, scopeRows } from "@/lib/platform/rls";

export const dynamic = "force-dynamic";

interface Hit {
  type: string;
  label: string;
  sublabel?: string;
  href: string;
}

const PER_TYPE = 5;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function contains(v: unknown, q: string): boolean {
  return str(v).toLowerCase().includes(q.toLowerCase());
}

/** Airtable "Job" link → first linked job rec id, or null (org-global). */
function jobOf(r: Record<string, unknown>): string | null {
  const link = r["Job"];
  return Array.isArray(link) && link.length > 0 ? String(link[0]) : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ org: string }> },
) {
  const { org } = await params;
  const ctx = await requireOrgCtx(org); // also gates membership when auth is on
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });

  const p = (path: string) => orgPath(ctx.orgSlug, path);
  const take = PER_TYPE;
  const scope = await currentJobScope(ctx);
  if (airtableEnabled(ctx)) {
    // VARIATIONS live in CHANGE_LOG now; VENDORS/QUOTES are optional Domain-tier
    // tables absent from Spec 12 construction bases — read tolerantly so a
    // missing table yields no hits rather than 403-ing the whole search.
    const [jobs, actions, risks, decisions, variations, documents, vendors, quotes] =
      await Promise.all([
        core.list(ctx.orgSlug, "JOBS", { maxRecords: 500 }),
        core.list(ctx.orgSlug, "ISSUES", { maxRecords: 500 }),
        core.list(ctx.orgSlug, "RISKS", { maxRecords: 500 }),
        core.list(ctx.orgSlug, "DECISIONS", { maxRecords: 500 }),
        core.list(ctx.orgSlug, "CHANGE_LOG", { maxRecords: 500, filterByFormula: VARIATION_FILTER }),
        core.list(ctx.orgSlug, "DOCUMENTS", { maxRecords: 500 }),
        listOptional(ctx.orgSlug, "VENDORS", { maxRecords: 500 }),
        listOptional(ctx.orgSlug, "QUOTES", { maxRecords: 500 }),
      ]);
    const results: Hit[] = [
      ...scopeRows(jobs, (j) => j.id, scope)
        .filter((j) => contains(j["Job_Name"], q))
        .slice(0, take)
        .map((j) => ({ type: "Project", label: str(j["Job_Name"]), sublabel: "", href: p(`/projects/${j.id}`) })),
      ...scopeRows(actions, jobOf, scope)
        .filter((a) => contains(a["Action_Name"], q))
        .slice(0, take)
        .map((a) => ({ type: "Action", label: str(a["Action_Name"]), sublabel: str(a["Status"]), href: p(`/actions/${a.id}`) })),
      ...scopeRows(risks, jobOf, scope)
        .filter((r) => contains(r["Risk"], q))
        .slice(0, take)
        .map((r) => ({ type: "Risk", label: str(r["Risk"]), sublabel: str(r["Status"]), href: p(`/risks/${r.id}`) })),
      ...scopeRows(decisions, jobOf, scope)
        .filter((d) => contains(d["Decision_Name"], q) || contains(d["Decision_Description"], q))
        .slice(0, take)
        .map((d) => ({ type: "Decision", label: str(d["Decision_Name"]), sublabel: str(d["Status"]), href: p(`/decisions/${d.id}`) })),
      ...scopeRows(variations, jobOf, scope)
        .filter((v) => contains(v["Change_Name"], q) || contains(v["Ref_Number"], q))
        .slice(0, take)
        .map((v) => ({ type: "Variation", label: str(v["Change_Name"]), sublabel: str(v["Ref_Number"]) || str(v["Status"]), href: p(`/variations/${v.id}`) })),
      ...scopeRows(documents, jobOf, scope)
        .filter((d) => contains(d["Document_Name"], q))
        .slice(0, take)
        .map((d) => ({ type: "Document", label: str(d["Document_Name"]), sublabel: str(d["Document_Type"]), href: p(`/documents/${d.id}`) })),
      ...vendors
        .filter((v) => contains(v["Vendor_Name"], q))
        .slice(0, take)
        .map((v) => ({ type: "Vendor", label: str(v["Vendor_Name"]), sublabel: str(v["Category"]), href: p(`/vendors/${v.id}`) })),
      ...scopeRows(quotes, jobOf, scope)
        .filter((q2) => contains(q2["Title"], q) || contains(q2["Ref_Number"], q))
        .slice(0, take)
        .map((q2) => ({ type: "Quote", label: str(q2["Title"]), sublabel: str(q2["Ref_Number"]) || str(q2["Status"]), href: p(`/quotes/${q2.id}`) })),
    ];
    return NextResponse.json({ results });
  }

  const where = { orgId: ctx.orgId };
  const [jobs, actions, risks, decisions, variations, documents, vendors, quotes] =
    await Promise.all([
      db(ctx).platJob.findMany({
        // Case-insensitive to match the Airtable branch above, which lowercases
        // both sides — without `mode` Postgres `contains` is case-sensitive, so
        // "maleny" found nothing while "Maleny" did.
        where: {
          ...where,
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { code: { contains: q, mode: "insensitive" } },
          ],
        },
        take,
        orderBy: { updatedAt: "desc" },
      }),
      db(ctx).platActionHub.findMany({
        where: { ...where, title: { contains: q } },
        take,
        orderBy: { updatedAt: "desc" },
      }),
      db(ctx).platConRisk.findMany({
        where: { ...where, description: { contains: q } },
        take,
        orderBy: { createdAt: "desc" },
      }),
      db(ctx).platDecision.findMany({
        where: { ...where, description: { contains: q } },
        take,
        orderBy: { createdAt: "desc" },
      }),
      db(ctx).platConVariationOrder.findMany({
        where: { ...where, OR: [{ title: { contains: q } }, { refNumber: { contains: q } }] },
        take,
        orderBy: { createdAt: "desc" },
      }),
      db(ctx).platDocument.findMany({
        where: { ...where, title: { contains: q } },
        take,
        orderBy: { createdAt: "desc" },
      }),
      db(ctx).platConVendor.findMany({
        where: { ...where, name: { contains: q } },
        take,
        orderBy: { name: "asc" },
      }),
      db(ctx).platConQuote.findMany({
        where: { ...where, OR: [{ title: { contains: q } }, { refNumber: { contains: q } }] },
        take,
        orderBy: { createdAt: "desc" },
      }),
    ]);

  const pgJob = (x: { jobId: number | null }) => (x.jobId != null ? String(x.jobId) : null);
  const results: Hit[] = [
    ...scopeRows(jobs, (j) => String(j.id), scope).map((j) => ({ type: "Project", label: j.name, sublabel: j.code, href: p(`/projects/${j.id}`) })),
    ...scopeRows(actions, pgJob, scope).map((a) => ({ type: "Action", label: a.title, sublabel: a.status, href: p(`/actions/${a.id}`) })),
    ...scopeRows(risks, pgJob, scope).map((r) => ({ type: "Risk", label: r.description, sublabel: r.status, href: p(`/risks/${r.id}`) })),
    ...scopeRows(decisions, pgJob, scope).map((d) => ({ type: "Decision", label: d.description, sublabel: d.status, href: p(`/decisions/${d.id}`) })),
    ...scopeRows(variations, pgJob, scope).map((v) => ({ type: "Variation", label: v.title, sublabel: v.refNumber || v.status, href: p(`/variations/${v.id}`) })),
    ...scopeRows(documents, pgJob, scope).map((d) => ({ type: "Document", label: d.title, sublabel: d.docType, href: p(`/documents/${d.id}`) })),
    ...vendors.map((v) => ({ type: "Vendor", label: v.name, sublabel: v.category, href: p(`/vendors/${v.id}`) })),
    ...scopeRows(quotes, pgJob, scope).map((q2) => ({ type: "Quote", label: q2.title, sublabel: q2.refNumber || q2.status, href: p(`/quotes/${q2.id}`) })),
  ];

  return NextResponse.json({ results });
}
