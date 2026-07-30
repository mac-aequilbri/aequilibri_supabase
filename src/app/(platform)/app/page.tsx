// Organisation picker — entry point of the platform routes. Tenancy is
// carried in the URL from here on (/app/[org]/...), not in a cookie.
// With Clerk active, only organisations the signed-in user belongs to are
// listed; demo mode shows everything.

import Link from "next/link";
import { OrgLogo } from "@/components/OrgLogo";
import {
  listControlTeam,
  listOrgRegistry,
  readMetricsSnapshot,
  type OrgMetricsSnapshot,
} from "@/lib/platform/controlPlane";
import { getAuthEmail, isPlatformAdmin } from "@/lib/platform/org-context";
import { deleteOrgAction } from "./actions";
import { ClientCardMetrics } from "./ClientCardMetrics";
import { DeleteClientButton } from "./DeleteClientButton";

export const dynamic = "force-dynamic";

/** Pull the branding logo (data URL) out of an org's settings JSON, if any. */
function logoFromSettings(settingsRaw: string): string | undefined {
  try {
    return (JSON.parse(settingsRaw) as { branding?: { logo?: string } })?.branding?.logo || undefined;
  } catch {
    return undefined;
  }
}

interface OrgCard {
  slug: string;
  name: string;
  vertical: string;
  defaultEngagementType: string;
  emails: string[];
  logo?: string;
  /** Cached picker highlights (control mode only); the card renders these
   *  instantly and refreshes in the background if stale. */
  metrics: OrgMetricsSnapshot | null;
}

export default async function OrgPickerPage({
  searchParams,
}: {
  searchParams: Promise<{ denied?: string; deleted?: string; base?: string }>;
}) {
  const { denied, deleted, base } = await searchParams;
  const email = await getAuthEmail();
  const canProvision = await isPlatformAdmin();

  // Control plane resolves the store (Airtable control base or Postgres —
  // lib/platform/controlPlane); the picker renders the same either way.
  const reg = await listOrgRegistry();
  const orgs: OrgCard[] = await Promise.all(
    reg.map(async (e) => ({
      slug: e.slug,
      name: e.name,
      vertical: e.vertical,
      defaultEngagementType: e.defaultEngagementType,
      emails: (await listControlTeam(e.slug)).map((m) => m.email.toLowerCase()),
      logo: logoFromSettings(e.settings),
      metrics: readMetricsSnapshot(e.settings),
    })),
  );
  orgs.sort((a, b) => a.name.localeCompare(b.name));
  // Platform operators (PLATFORM_ADMIN_EMAILS) oversee every client, so they
  // see the full registry. Demo mode (no auth) also shows everything. Every
  // other signed-in user sees only the orgs they belong to.
  const visible =
    email === null || canProvision ? orgs : orgs.filter((o) => o.emails.includes(email));

  return (
    <main className="max-w-4xl mx-auto px-6 py-16">
      <div className="flex items-start justify-between gap-6 mb-10">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold mb-2">Choose an organisation</h1>
          <p className="text-neutral-600">
            Each organisation is an isolated customer instance on the shared platform core.
          </p>
        </div>
        {canProvision && (
          <div className="flex items-center gap-2 shrink-0">
            <Link href="/app/templates" className="btn-ae-outline">
              Templates
            </Link>
            <Link href="/app/new" className="btn-ae whitespace-nowrap">
              + Onboard customer
            </Link>
          </div>
        )}
      </div>
      {deleted ? (
        <p className="mb-6 text-sm text-emerald-700">
          Removed <strong>{deleted}</strong> from the registry. Its tenant data was <strong>not</strong>{" "}
          deleted — the organisation is deactivated and can be restored by an operator.
          {base ? (
            <>
              {" "}(Its legacy Airtable base <span className="font-mono">{base}</span> is untouched.)
            </>
          ) : null}
        </p>
      ) : null}
      {denied === "admin" ? (
        <p className="mb-6 text-sm text-red-600">
          Provisioning new organisations requires a platform operator (PLATFORM_ADMIN_EMAILS).
        </p>
      ) : denied ? (
        <p className="mb-6 text-sm text-red-600">
          You are not a member of that organisation. Ask its admin to add your email to the team.
        </p>
      ) : null}
      {visible.length === 0 ? (
        <p className="text-sm text-neutral-500">
          {email === null ? (
            <>
              No organisations found — run <code>node prisma/seed.mjs</code> to load the demo data.
            </>
          ) : (
            <>No organisations are linked to {email} yet — onboard one above, or ask an admin to add you.</>
          )}
        </p>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          {visible.map((org) => (
            <div key={org.slug} className="ae-card ae-card-link flex flex-col">
              <Link href={`/app/${org.slug}`} className="flex items-start gap-4 p-6 group">
                <OrgLogo logo={org.logo} name={org.name} size={44} fallback />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-lg font-semibold truncate">{org.name}</h2>
                    <span className="text-ae-space opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      →
                    </span>
                  </div>
                  <p className="text-sm text-neutral-600 capitalize mt-0.5">
                    {org.vertical} · {org.defaultEngagementType.replace(/_/g, " ")}
                  </p>
                  <ClientCardMetrics slug={org.slug} cached={org.metrics} />
                </div>
              </Link>
              {canProvision && (
                <div className="flex justify-end px-6 py-3 border-t border-neutral-100">
                  <DeleteClientButton action={deleteOrgAction} slug={org.slug} name={org.name} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
