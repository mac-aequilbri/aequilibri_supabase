import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { SubmitButton } from "@/components/form/SubmitButton";
import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { loadJobDetail } from "@/lib/platform/jobDetailSource";
import { requireOrgCtx } from "@/lib/platform/org-context";
import { currentJobScope, inScope } from "@/lib/platform/rls";
import { updateJob } from "../../actions";

export const dynamic = "force-dynamic";

export default async function EditProjectPage({
  params,
}: {
  params: Promise<{ org: string; id: string }>;
}) {
  const { org, id } = await params;
  const ctx = await requireOrgCtx(org);
  const detail = await loadJobDetail(ctx, id);
  if (!detail) notFound();
  // RLS: can't edit a project you're not assigned to (matches the view page).
  if (!inScope(await currentJobScope(ctx), detail.id)) notFound();
  const pgJob = !airtableEnabled(ctx)
    ? await db(ctx).platJob.findFirst({ where: { id: Number(id), orgId: ctx.orgId } })
    : null;
  const airJob = airtableEnabled(ctx) ? await core.get(ctx.orgSlug, "JOBS", detail.id).catch(() => null) : null;
  const job = {
    id: detail.id,
    code: detail.code,
    name: detail.name,
    status: pgJob?.status ?? (airJob && typeof airJob["Status"] === "string" ? airJob["Status"] : "intake"),
    completionPct: detail.completionPct,
    healthScore: detail.healthScore,
    budgetTotal: detail.budget,
    startDate: pgJob?.startDate ?? (airJob ? (typeof airJob["Date_Estimated"] === "string" ? new Date(airJob["Date_Estimated"]) : null) : null),
    targetEndDate: pgJob?.targetEndDate ?? (airJob ? (typeof airJob["Target_Completion"] === "string" ? new Date(airJob["Target_Completion"]) : null) : null),
    summary: detail.summary,
  };

  const dateVal = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

  return (
    <div className="p-6 max-w-xl">
      <PageHeader title={`Edit ${job.code}`} />
      <form action={updateJob} className="ae-card p-5 space-y-4">
        <input type="hidden" name="org" value={ctx.orgSlug} />
        <input type="hidden" name="recordId" value={job.id} />
        <label className="block text-sm">
          <span className="text-neutral-600">Name</span>
          <input name="name" defaultValue={job.name} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="block text-sm">
            <span className="text-neutral-600">Status</span>
            <select name="status" defaultValue={job.status} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2">
              {["intake", "assessment", "active", "on_hold", "completed", "archived"].map((s) => (
                <option key={s} value={s}>
                  {s.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-neutral-600">Completion %</span>
            <input type="number" name="completionPct" min={0} max={100} defaultValue={job.completionPct} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
          </label>
          <label className="block text-sm">
            <span className="text-neutral-600">Health score</span>
            <input type="number" name="healthScore" min={0} max={100} defaultValue={job.healthScore} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
          </label>
          <label className="block text-sm">
            <span className="text-neutral-600">Budget total $</span>
            <input type="number" step="0.01" name="budgetTotal" defaultValue={job.budgetTotal} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
          </label>
          <label className="block text-sm">
            <span className="text-neutral-600">Start date</span>
            <input type="date" name="startDate" defaultValue={dateVal(job.startDate)} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
          </label>
          <label className="block text-sm">
            <span className="text-neutral-600">Target end</span>
            <input type="date" name="targetEndDate" defaultValue={dateVal(job.targetEndDate)} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-neutral-600">Summary</span>
          <textarea name="summary" rows={3} defaultValue={job.summary} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
        </label>
        <SubmitButton label="Save changes" />
      </form>
    </div>
  );
}
