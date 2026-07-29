// Add an industry → sub-industry → template mapping (platform-admin only).

import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { SubmitButton } from "@/components/form/SubmitButton";
import { listTemplateRegistry } from "@/lib/platform/controlPlane";
import { isPlatformAdmin } from "@/lib/platform/org-context";
import { INDUSTRY_TAXONOMY, industryOptions } from "@/lib/platform/industryTaxonomy";
import { createTemplateMapping } from "../actions";
import { TemplateTaxonomyFields } from "./TemplateTaxonomyFields";

export const dynamic = "force-dynamic";

export default async function NewTemplateMappingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (!(await isPlatformAdmin())) redirect("/app?denied=admin");
  const { error } = await searchParams;

  // Seed the industry dropdown with the curated taxonomy plus whatever is
  // already mapped, so the list reflects reality as new verticals are added.
  const registry = await listTemplateRegistry({ includeInactive: true });
  const industries = industryOptions(registry.map((r) => r.industry));

  return (
    <main className="max-w-xl mx-auto px-6 py-10">
      <PageHeader
        title="New industry template mapping"
        actions={[{ href: "/app/templates", label: "Back to templates", variant: "outline" }]}
      />
      {error && <p className="text-ae-danger text-sm mb-4">{error}</p>}

      <form action={createTemplateMapping} className="ae-card p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <TemplateTaxonomyFields taxonomy={INDUSTRY_TAXONOMY} industries={industries} />
          <label className="block text-sm">
            <span className="text-neutral-600">Vertical key</span>
            <input name="verticalKey" placeholder="legal" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 font-mono text-xs" />
            <span className="block mt-1 text-xs text-neutral-500">Routing key for DOMAIN_LABELS + assessment module. Defaults from the industry name.</span>
          </label>
          <label className="block text-sm">
            <span className="text-neutral-600">Sort order</span>
            <input type="number" name="sortOrder" defaultValue={0} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-neutral-600">Template base id *</span>
          <input
            name="templateBaseId"
            required
            pattern="app[A-Za-z0-9]{14,}"
            placeholder="appXXXXXXXXXXXXXX"
            className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 font-mono text-xs"
          />
          <span className="block mt-1 text-xs text-neutral-500">
            The vertical template base new customers in this industry are cloned from. Build it first.
          </span>
        </label>
        <label className="block text-sm">
          <span className="text-neutral-600">Notes</span>
          <input name="notes" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
        </label>
        <SubmitButton label="Add mapping" pendingLabel="Adding…" />
      </form>
    </main>
  );
}
