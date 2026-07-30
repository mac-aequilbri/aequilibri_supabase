// Backend diagnostics — answers "where does this org's data live?" at a
// glance. Read-only, admin-gated. Postgres is the only backend (the Airtable
// runtime was decommissioned in migration-plan Phase 6), so this page shows
// the resolved backend plus the org's Module 1 schema versions.

import { PageHeader } from "@/components/PageHeader";
import { Chip } from "@/components/ui/Chip";
import { requireAdmin, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";

export const dynamic = "force-dynamic";

const POSTGRES_BY_DESIGN = [
  "Failed-write audit rows + pending-write claim registry",
  "UC1 roofing subsystem (direct Prisma)",
  "Client-portal tokens + accounting connections",
];

export default async function DiagnosticsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requireOrgCtx(org);
  await requireAdmin(ctx);

  const module1 = ctx.config.module1;

  return (
    <div className="p-6 max-w-3xl">
      <PageHeader
        title="Backend diagnostics"
        subtitle="Where this organisation's records actually live."
      />

      <section className="ae-card p-5 mb-6 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-neutral-600">Data backend (this org)</span>
          <Chip variant="neutral" className="font-mono">
            postgres — reads &amp; writes use the org&apos;s tenant database
          </Chip>
        </div>
        {module1 && (
          <>
            <div className="flex justify-between">
              <span className="text-neutral-600">Core schema version</span>
              <span className="font-mono text-xs">{module1.schema.coreVersion}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-600">Project delivery version</span>
              <span className="font-mono text-xs">{module1.schema.projectDeliveryVersion}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-neutral-600">Module 1 migration status</span>
              <span className="font-mono text-xs">{module1.schema.migrationStatus}</span>
            </div>
          </>
        )}
        <div className="pt-2 border-t border-neutral-100">
          <a className="text-xs underline text-neutral-600" href={orgPath(ctx.orgSlug, "/schema-drift")}>
            Cross-org schema drift →
          </a>
        </div>
      </section>

      <section className="ae-card p-5 text-sm">
        <h2 className="text-base font-semibold mb-2">Postgres by design</h2>
        <ul className="list-disc pl-5 space-y-1 text-neutral-600">
          {POSTGRES_BY_DESIGN.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
