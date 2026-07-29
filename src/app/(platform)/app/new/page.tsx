// Customer Onboarding Engine (module 1) — provision a new customer instance:
// Instance Setup (configuration, persona, authority, features, first admin)
// + Domain Knowledge Initialisation (expert rules captured before any jobs).

import { redirect } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { VERTICAL_TEMPLATE_BASE_IDS } from "@/lib/airtable/config";
import { listTemplateRegistry } from "@/lib/platform/controlPlane";
import { isPlatformAdmin } from "@/lib/platform/org-context";
import { DEFAULT_FEATURES } from "@/lib/platform/types";
import { FormStepper } from "@/components/form/FormStepper";
import { PendingSubmitButton } from "@/app/(platform)/app/[org]/assess/SubmitButtons";
import { provisionOrgAction } from "./actions";
import { LogoField } from "./LogoField";

export const dynamic = "force-dynamic";

const FEATURE_LABELS: Record<string, string> = {
  chat: "Standalone chat",
  risks: "Risk register",
  variations: "Variation orders",
  reports: "Weekly reports",
  meeting_minutes: "Meeting minutes",
  documents: "Documents",
  portal: "Client portal",
  accounting: "Accounting (stub)",
  bim: "BIMx 3D models",
  delay_cascade: "Delay cascade",
  procurement: "Procurement",
  room_matrix: "Room matrix",
  project_plan: "Project plan",
  vendors: "Vendors",
  learning_rules: "Learning rules",
};

const VERTICAL_LABELS: Record<string, string> = {
  construction: "Construction (Project Delivery)",
  roofing: "Roofing (PCR Estimation)",
};
const VERTICALS = Object.keys(VERTICAL_TEMPLATE_BASE_IDS);

const ENGAGEMENTS = [
  ["long_project", "Long project (phases, budget vs actual, variations)"],
  ["short_job", "Short job (scheduling, materials, invoice)"],
  ["ongoing", "Ongoing lifecycle"],
  ["seasonal", "Seasonal cycle"],
] as const;

export default async function NewOrganisationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  if (!(await isPlatformAdmin())) redirect("/app?denied=admin");

  // Industry options come from the template registry (control base). Fall back
  // to the hardcoded vertical map if the registry is empty/unreachable. Option
  // value = registry recordId (resolved server-side), or a bare vertical key in
  // the fallback case.
  const registry = await listTemplateRegistry();
  const verticalOptions = registry.length
    ? registry.map((r) => ({ value: r.recordId, label: `${r.industry} — ${r.subIndustry}`, baseId: r.templateBaseId }))
    : VERTICALS.map((v) => ({ value: v, label: VERTICAL_LABELS[v] ?? v, baseId: VERTICAL_TEMPLATE_BASE_IDS[v] }));

  return (
    <main className="max-w-2xl mx-auto px-6 py-10">
      <PageHeader
        title="Onboard a new customer"
        subtitle="Provisions a configured, ready-to-learn instance: Core tables are shared, so a new customer is configuration — not new infrastructure."
        actions={[{ href: "/app", label: "Back to organisations", variant: "outline" }]}
      />
      {error && <p className="text-ae-danger text-sm mb-4">{error}</p>}

      <form action={provisionOrgAction} className="relative">
        <FormStepper
          steps={[
            {
              title: "Instance setup",
              body: (
        <section className="ae-card p-5 space-y-4">
          <div className="rounded border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 space-y-1">
            <p className="font-medium text-neutral-700">The customer&apos;s Airtable base is created automatically.</p>
            <p>On submit, a new base is cloned from the selected industry&apos;s template. Leave the base-id field blank to auto-create; only fill it to reuse an existing base.</p>
            <ul className="font-mono">
              {verticalOptions.map((o) => (
                <li key={o.value}>
                  {o.label}: {o.baseId}
                </li>
              ))}
            </ul>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-neutral-600">Customer name *</span>
              <input name="name" required placeholder="New Builder Co" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-neutral-600">URL slug *</span>
              <input
                name="slug"
                required
                pattern="[a-z0-9][a-z0-9-]+"
                placeholder="new-builder-co"
                className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 font-mono text-xs"
              />
              <span className="block mt-1 text-xs text-neutral-500">Becomes /app/&lt;slug&gt; — lowercase, hyphens.</span>
            </label>
            <LogoField />
            <label className="block text-sm">
              <span className="text-neutral-600">Industry · sub-industry *</span>
              <select name="templateOption" required defaultValue={verticalOptions[0]?.value} className="mt-1 w-full rounded border border-neutral-300 px-3 py-2">
                {verticalOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              <span className="block mt-1 text-xs text-neutral-500">
                Determines which Airtable template the customer&apos;s base is cloned from. Manage the list under Templates.
              </span>
            </label>
            <label className="block text-sm">
              <span className="text-neutral-600">Airtable base ID (optional)</span>
              <input
                name="airtableBaseId"
                pattern="app[A-Za-z0-9]{14,}"
                placeholder="auto-created if blank"
                className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 font-mono text-xs"
              />
              <span className="block mt-1 text-xs text-neutral-500">
                Leave blank to auto-create the base from the vertical template. Provide an id only to reuse an existing base.
              </span>
            </label>
            <label className="block text-sm">
              <span className="text-neutral-600">Default engagement type</span>
              <select name="defaultEngagementType" defaultValue="long_project" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2">
                {ENGAGEMENTS.map(([value]) => (
                  <option key={value} value={value}>
                    {value.replace("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-neutral-600">AI write authority</span>
              <select name="aiAuthority" defaultValue="approve_required" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2">
                <option value="propose_only">Propose only — every AI write needs approval</option>
                <option value="approve_required">Approval required — every AI write needs approval</option>
                <option value="auto_low_risk">Auto low-risk — actions/decisions apply, big writes need approval</option>
              </select>
            </label>
          </div>
          <fieldset className="text-sm">
            <legend className="text-neutral-600 mb-1">Allowed engagement types</legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {ENGAGEMENTS.map(([value, label]) => (
                <label key={value} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name={`engagement_${value}`} defaultChecked={value === "long_project" || value === "short_job"} />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-neutral-600">First team member name</span>
              <input name="adminName" placeholder="Pat Builder" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-neutral-600">Team member email</span>
              <input type="email" name="adminEmail" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
            </label>
            <label className="block text-sm">
              <span className="text-neutral-600">Initial role</span>
              <select name="adminRole" defaultValue="owner" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2">
                <option value="owner">Owner</option>
                <option value="builder">Builder</option>
                <option value="architect">Architect</option>
                <option value="broker">Broker</option>
              </select>
            </label>
          </div>
        </section>
              ),
            },
            {
              title: "Assistant & features",
              body: (
        <section className="ae-card p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="block text-sm">
              <span className="text-neutral-600">Assistant name</span>
              <input name="assistantName" placeholder="Site Assistant" className="mt-1 w-full rounded border border-neutral-300 px-3 py-2" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-neutral-600">Assistant persona</span>
            <textarea
              name="assistantPersona"
              rows={2}
              placeholder="You are the AI project coordinator for New Builder Co. Be concise and practical."
              className="mt-1 w-full rounded border border-neutral-300 px-3 py-2"
            />
          </label>
          <fieldset className="text-sm">
            <legend className="text-neutral-600 mb-1">Enabled screens</legend>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-1">
              {Object.keys(DEFAULT_FEATURES).map((key) => (
                <label key={key} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name={`feature_${key}`} defaultChecked={DEFAULT_FEATURES[key]} />
                  {FEATURE_LABELS[key] ?? key}
                </label>
              ))}
            </div>
          </fieldset>
        </section>
              ),
            },
            {
              title: "Domain knowledge",
              body: (
        <section className="ae-card p-5 space-y-4">
          <p className="text-xs text-neutral-500">
            Encode the customer&apos;s expertise before any jobs run — these become active guidance
            rules the assistant follows from the first session, and the learning loop refines them
            from there.
          </p>
          <label className="block text-sm">
            <span className="text-neutral-600">Initial rules of thumb (one per line)</span>
            <textarea
              name="initialRules"
              rows={4}
              placeholder={"Always allow 10% contingency on coastal sites\nNever schedule concrete pours on Fridays without a backup pump"}
              className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-xs font-mono"
            />
          </label>
          <label className="block text-sm">
            <span className="text-neutral-600">Budget categories (one per line)</span>
            <textarea
              name="budgetCategories"
              rows={3}
              placeholder={"Preliminaries\nStructure\nServices\nFinishes"}
              className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-xs font-mono"
            />
          </label>
          <label className="block text-sm">
            <span className="text-neutral-600">Client priorities / budget principles (one per line)</span>
            <textarea
              name="clientPriorities"
              rows={3}
              placeholder={"Prioritise long-life exterior materials\nKeep variation exposure low\nProtect landscaping budget"}
              className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-xs font-mono"
            />
          </label>
          <label className="block text-sm">
            <span className="text-neutral-600">Trades / categories / items (Trade &gt; Category &gt; Item)</span>
            <textarea
              name="tradeReferences"
              rows={4}
              placeholder={"Tiling > Floor > Porcelain tiles\nJoinery > Kitchen > Pantry cabinetry\nElectrical > Lighting > Pendant lights"}
              className="mt-1 w-full rounded border border-neutral-300 px-3 py-2 text-xs font-mono"
            />
          </label>
        </section>
              ),
            },
          ]}
          submit={
            <PendingSubmitButton
              label="Provision customer instance"
              pendingTitle="Provisioning instance"
              stages={[
                "Creating the customer's Airtable base…",
                "Cloning the template tables…",
                "Ensuring app runtime tables…",
                "Checking record access…",
                "Writing instance configuration…",
                "Registering the organisation…",
              ]}
            />
          }
        />
      </form>
    </main>
  );
}
