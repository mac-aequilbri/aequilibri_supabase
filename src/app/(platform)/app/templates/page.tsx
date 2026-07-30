// Template registry admin (platform-admin only) — manage the industry →
// sub-industry → template-base mappings that drive the /app/new dropdown and
// onboarding. Adding a row here makes a new industry onboardable with no deploy.

import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { ConfirmSubmitButton } from "@/components/form/ConfirmSubmitButton";
import { SubmitButton } from "@/components/form/SubmitButton";
import { listTemplateRegistry } from "@/lib/platform/controlPlane";
import { isPlatformAdmin } from "@/lib/platform/org-context";
import { deleteTemplateMapping, toggleTemplateMapping } from "./actions";

export const dynamic = "force-dynamic";

export default async function TemplateRegistryPage() {
  if (!(await isPlatformAdmin())) redirect("/app?denied=admin");
  const rows = await listTemplateRegistry({ includeInactive: true });

  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      <PageHeader
        title="Industry templates"
        subtitle="Industry → sub-industry → vertical mapping for onboarding (job catalog + assessment engine). Legacy Airtable template base ids are retained for reference only."
        actions={[
          { href: "/app/templates/new", label: "+ New mapping" },
          { href: "/app", label: "Back to organisations", variant: "outline" },
        ]}
      />

      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No mappings yet — add one to make a new industry onboardable.
        </p>
      ) : (
        <div className="ae-card overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th scope="col" className="p-3">Industry</th>
              <th scope="col" className="p-3">Sub-industry</th>
              <th scope="col" className="p-3">Vertical key</th>
              <th scope="col" className="p-3">Template base</th>
              <th scope="col" className="p-3">Active</th>
              <th scope="col" className="p-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.recordId} className="border-t border-neutral-100">
                <td className="p-3 font-medium">{r.industry}</td>
                <td className="p-3">{r.subIndustry || "—"}</td>
                <td className="p-3 font-mono text-xs">{r.verticalKey}</td>
                <td className="p-3 font-mono text-xs">{r.templateBaseId}</td>
                <td className="p-3">
                  <form action={toggleTemplateMapping} className="inline">
                    <input type="hidden" name="recordId" value={r.recordId} />
                    <input type="hidden" name="isActive" value={String(r.isActive)} />
                    <SubmitButton
                      label={r.isActive ? "Active" : "Inactive"}
                      pendingLabel="Updating…"
                      className={`text-xs font-semibold ${r.isActive ? "text-ae-success" : "text-neutral-500"}`}
                    />
                  </form>
                </td>
                <td className="p-3 text-right">
                  <form action={deleteTemplateMapping} className="inline">
                    <input type="hidden" name="recordId" value={r.recordId} />
                    <ConfirmSubmitButton
                      label="🗑 Delete"
                      confirmLabel="Confirm delete"
                      pendingLabel="Deleting…"
                      className="btn-ae-danger-outline"
                    />
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      <p className="mt-6 text-xs text-neutral-500">
        Note: adding a mapping only wires up routing. A new industry still needs its template base built
        (Core clone + Domain Extension), plus DOMAIN_LABELS records and an assessment module for full support.
      </p>
    </main>
  );
}
