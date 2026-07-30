// Schema drift was an Airtable-only concern (customer bases were clones of the
// template). The Airtable backend is decommissioned (migration-plan Phase 6),
// so this page is a retired empty state. The route survives because nav and
// diagnostics still link it. Admin-gated.

import { PageHeader } from "@/components/PageHeader";
import { requireAdmin, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";

export const dynamic = "force-dynamic";

export default async function SchemaDriftPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const ctx = await requireOrgCtx(org);
  await requireAdmin(ctx);

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Schema drift"
        subtitle="Retired — all organisations run on Postgres."
      />

      <section className="ae-card p-5 mb-6 text-sm text-neutral-600">
        Schema drift monitoring retired with the Airtable backend. All org data
        lives in Postgres, where schema changes ship as migrations — there are
        no per-customer cloned bases to fall out of sync.
      </section>

      <p className="text-xs text-neutral-500">
        <a className="underline" href={orgPath(ctx.orgSlug, "/diagnostics")}>
          ← Backend diagnostics
        </a>
      </p>
    </div>
  );
}
