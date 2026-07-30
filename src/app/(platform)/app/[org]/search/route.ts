// Org-scoped global search backing the ⌘K palette. Every query is filtered by
// orgId (the tenancy guard enforces this), so search can never cross tenants,
// and each job-linked group is filtered to the viewer's job scope (§3/§7 RLS)
// so hits can't disclose records on unassigned projects. Vendors stay
// org-global. Returns a small, typed, grouped result set the client renders.

import { NextRequest, NextResponse } from "next/server";
import { db, prisma } from "@/lib/db";
import { requireOrgCtx } from "@/lib/platform/org-context";
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

  const where = { orgId: ctx.orgId };
  const [jobs, actions, risks, decisions, variations, documents, vendors, quotes] =
    await Promise.all([
      db(ctx).platJob.findMany({
        // Case-insensitive — without `mode` Postgres `contains` is
        // case-sensitive, so "maleny" found nothing while "Maleny" did.
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
