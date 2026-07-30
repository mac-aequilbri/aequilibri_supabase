import Link from "next/link";
import { FilterBar } from "@/components/FilterBar";
import { GroupHeading } from "@/components/GroupHeader";
import { EmptyState, PageHeader, StatusBadge } from "@/components/PageHeader";
import { currency } from "@/lib/format";
import { loadJobsList, type JobListView } from "@/lib/platform/jobsListSource";
import {
  applyListQuery,
  hasActiveFilters,
  parseListQuery,
  splitIntoGroups,
  toClientConfig,
} from "@/lib/platform/listQuery";
import { getCurrentViewer, requireOrgCtx } from "@/lib/platform/org-context";
import { orgPath } from "@/lib/platform/paths";
import { projectsListConfig } from "./listConfig";

export const dynamic = "force-dynamic";

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireOrgCtx((await params).org);
  const viewer = await getCurrentViewer(ctx);
  const query = parseListQuery(await searchParams, projectsListConfig);
  const filtered = hasActiveFilters(query);

  // Rich client-side list (per-status facets, exact total, sort, jump-to-page).
  const applied = applyListQuery(await loadJobsList(ctx, viewer), query, projectsListConfig);
  const jobs = applied.items;
  const { total, matching, facets, page, pageCount } = applied;
  const clientConfig = toClientConfig(projectsListConfig);

  const jobCard = (job: JobListView) => (
    <Link
      key={job.id}
      href={orgPath(ctx.orgSlug, `/projects/${job.id}`)}
      className="ae-card p-5 block hover:shadow-md transition-shadow"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{job.name}</h2>
          <p className="text-xs text-neutral-500">
            {[
              job.code,
              job.engagementType ? job.engagementType.replace("_", " ") : "",
              job.suburb || job.address || "no address",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <StatusBadge status={job.status} />
      </div>
      <div
        className="mt-3 h-2 rounded bg-neutral-100 overflow-hidden"
        role="progressbar"
        aria-valuenow={job.completionPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${job.name} completion`}
      >
        <div
          className="h-full rounded bg-[var(--ae-space,#1f2937)]"
          style={{ width: `${job.completionPct}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        {job.completionPct}% complete · health {job.healthScore}/100 · budget{" "}
        {currency(job.budgetTotal)} · {job.counts.phases} phases · {job.counts.actions} actions ·{" "}
        {job.counts.risks} risks
      </p>
    </Link>
  );

  return (
    <div className="p-6">
      <PageHeader
        title="Projects"
        subtitle="Every engagement — long projects and short jobs — on the shared core."
        actions={[{ href: orgPath(ctx.orgSlug, "/projects/new"), label: "+ New project" }]}
      />
      <FilterBar
        basePath={orgPath(ctx.orgSlug, "/projects")}
        config={clientConfig}
        query={query}
        shown={matching}
        total={total}
        counts={facets}
        page={page}
        pageCount={pageCount}
        searchPlaceholder="Search projects…"
      >
      {jobs.length === 0 ? (
        <EmptyState
          title={filtered ? "No projects match these filters" : "No projects yet"}
          hint={
            filtered
              ? "Try widening or clearing the filters above."
              : "Each project is a job on the platform — create one to start tracking phases, budget and risk."
          }
          action={{ href: orgPath(ctx.orgSlug, "/projects/new"), label: "+ New project" }}
        />
      ) : query.group ? (
        <div>
          {splitIntoGroups(jobs, query, projectsListConfig).map((section) => (
            <div key={section.key} className="mb-6">
              <GroupHeading label={section.label} count={section.count} />
              <div className="grid gap-4 lg:grid-cols-2">{section.rows.map(jobCard)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">{jobs.map(jobCard)}</div>
      )}
      </FilterBar>
    </div>
  );
}
