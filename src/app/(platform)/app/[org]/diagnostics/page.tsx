// Backend diagnostics — answers "is this org's data in Airtable or Postgres?"
// at a glance. Read-only, admin-gated. When AIRTABLE_MIGRATION is on, every
// mapped write and every *Source read uses the org's Airtable base; this page
// shows the live row counts on BOTH backends side by side so you can confirm
// where records actually land (a fresh Airtable org should fill the Airtable
// column and leave the Postgres column at its legacy/zero count).

import { PageHeader } from "@/components/PageHeader";
import { Chip } from "@/components/ui/Chip";
import { airtableEnabled, core, resolveBaseId, type CoreTableName } from "@/lib/airtable";
import { prisma } from "@/lib/db";
import { requireAdmin, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";

export const dynamic = "force-dynamic";

// Each row: a label, the Airtable table, and how to count the Postgres side for
// this org. Covers the onboard→job→risk→decision→variation flow plus the P2
// learning tables.
const ROWS: { label: string; air: CoreTableName; pg: (orgId: number) => Promise<number> }[] = [
  { label: "Jobs", air: "JOBS", pg: (orgId) => prisma.platJob.count({ where: { orgId } }) },
  { label: "Risks", air: "RISKS", pg: (orgId) => prisma.platConRisk.count({ where: { orgId } }) },
  { label: "Decisions", air: "DECISIONS", pg: (orgId) => prisma.platDecision.count({ where: { orgId } }) },
  { label: "Variations", air: "VARIATIONS", pg: (orgId) => prisma.platConVariationOrder.count({ where: { orgId } }) },
  { label: "Quotes", air: "QUOTES", pg: (orgId) => prisma.platConQuote.count({ where: { orgId } }) },
  { label: "Budget lines", air: "BUDGET", pg: (orgId) => prisma.platConBudgetLine.count({ where: { orgId } }) },
  { label: "Meeting minutes", air: "MEETING_MINUTES", pg: (orgId) => prisma.platConMeetingMinutes.count({ where: { orgId } }) },
  { label: "Learning rules", air: "LEARNING_RULES", pg: (orgId) => prisma.platLearningRule.count({ where: { orgId } }) },
  { label: "Corrections", air: "CORRECTIONS", pg: (orgId) => prisma.platCorrection.count({ where: { orgId } }) },
  { label: "Hypotheses", air: "HYPOTHESES", pg: (orgId) => prisma.platHypothesis.count({ where: { orgId } }) },
  { label: "Config references", air: "PLAT_CFG_REFERENCE", pg: (orgId) => prisma.platCfgReference.count({ where: { orgId } }) },
];

const POSTGRES_BY_DESIGN = [
  "Failed-write audit rows + pending-write claim registry (always Postgres, even in Airtable mode)",
  "UC1 roofing subsystem (direct Prisma, not on the migration path)",
  "Client-portal tokens + accounting connections",
];

// The inverse asymmetry: these only work with AIRTABLE_MIGRATION on.
const AIRTABLE_ONLY = [
  "Cascade write-effects + advisories (runCascades is Airtable-gated)",
  "Schema drift checks + base provisioning (inherently Airtable concerns)",
];

async function airtableCount(orgSlug: string, table: CoreTableName): Promise<number | string> {
  try {
    // maxRecords >= UNCAP_THRESHOLD means "follow pagination to the end", so
    // this is a true full count, not a 1000-row cap.
    const rows = await core.list(orgSlug, table, { maxRecords: 1000 });
    return rows.length;
  } catch (err) {
    return `err: ${(err instanceof Error ? err.message : String(err)).slice(0, 40)}`;
  }
}

export default async function DiagnosticsPage({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requireOrgCtx(org);
  await requireAdmin(ctx);

  const on = airtableEnabled(ctx); // per-org: honours features.data_backend_postgres
  const globalOn = airtableEnabled();
  let baseId = "—";
  if (on) {
    baseId = await resolveBaseId(ctx.orgSlug).catch((e) => `unresolved: ${e instanceof Error ? e.message : String(e)}`);
  }

  const counts = await Promise.all(
    ROWS.map(async (r) => ({
      label: r.label,
      air: on ? await airtableCount(ctx.orgSlug, r.air) : "—",
      pg: await r.pg(ctx.orgId).catch(() => "err"),
    })),
  );
  const module1 = ctx.config.module1;

  return (
    <div className="p-6 max-w-3xl">
      <PageHeader
        title="Backend diagnostics"
        subtitle="Where this organisation's records actually live."
      />
      <p className="-mt-3 mb-6 text-sm text-neutral-500">
        Healthy = new records land in the Airtable column below.
      </p>

      <section className="ae-card p-5 mb-6 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-neutral-600">Data backend (this org)</span>
          <Chip variant={on ? "success" : "neutral"} className="font-mono">
            {on
              ? "airtable — reads & writes use this org's base"
              : globalOn
                ? "postgres — per-org data_backend_postgres override"
                : "postgres — AIRTABLE_MIGRATION off globally"}
          </Chip>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-600">Resolved base</span>
          <span className="font-mono text-xs">{baseId}</span>
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

      <section className="ae-card p-5 mb-6">
        <h2 className="text-base font-semibold mb-3">Row counts by backend</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th scope="col" className="py-1 pr-2">Entity</th>
              <th scope="col" className="py-1 pr-2 text-right">Airtable (this base)</th>
              <th scope="col" className="py-1 text-right">Postgres (this org)</th>
            </tr>
          </thead>
          <tbody>
            {counts.map((c) => (
              <tr key={c.label} className="border-t border-neutral-100">
                <td className="py-1.5 pr-2">{c.label}</td>
                <td className="py-1.5 pr-2 text-right font-mono">
                  {typeof c.air === "string" && c.air.startsWith("err") ? (
                    <Chip variant="danger" className="font-mono">{c.air}</Chip>
                  ) : (
                    String(c.air)
                  )}
                </td>
                <td className="py-1.5 text-right font-mono text-neutral-500">
                  {c.pg === "err" ? <Chip variant="danger" className="font-mono">err</Chip> : String(c.pg)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-neutral-500 mt-3">
          With the flag on, new records should land in the Airtable column. A non-zero Postgres
          count for a migrated org is legacy data (or writes made while the flag was off).
        </p>
      </section>

      <section className="ae-card p-5 mb-6 text-sm">
        <h2 className="text-base font-semibold mb-2">Postgres by design (not migrated)</h2>
        <ul className="list-disc pl-5 space-y-1 text-neutral-600">
          {POSTGRES_BY_DESIGN.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </section>

      <section className="ae-card p-5 text-sm">
        <h2 className="text-base font-semibold mb-2">Airtable-only (unavailable when the flag is off)</h2>
        <ul className="list-disc pl-5 space-y-1 text-neutral-600">
          {AIRTABLE_ONLY.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
        <p className="text-xs text-neutral-500 mt-3">
          The flag is a process-wide, one-way migration lever — flipping it moves every org at
          once and does not migrate existing rows. See docs/airtable-postgres-switch-audit.md.
        </p>
      </section>
    </div>
  );
}
