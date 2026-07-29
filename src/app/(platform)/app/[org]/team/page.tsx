// Team & access management (governance framework: Authentication & User
// Provisioning). Owner-gated. Members listed here are the org's authoritative
// access list: with Clerk active a user signs in and is matched by email;
// inviting sends a Clerk invitation email; deactivating revokes access.

import { PageHeader } from "@/components/PageHeader";
import { ConfirmSubmitButton } from "@/components/form/ConfirmSubmitButton";
import { SubmitButton } from "@/components/form/SubmitButton";
import { buttonClass } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { MessageBar, type MessageVariant } from "@/components/ui/MessageBar";
import { controlPlaneEnabled, listControlAssignments } from "@/lib/platform/controlPlane";
import { clerkEnabled } from "@/lib/platform/authConfig";
import { loadJobOptions } from "@/lib/platform/jobOptionsSource";
import { requireAdmin, requireOrgCtx } from "@/lib/platform/org-context";
import { listMembers } from "@/lib/platform/provisioning";
import { rolePriority } from "@/lib/platform/module1Governance";
import { rlsExempt } from "@/lib/platform/roles";
import {
  inviteMemberAction,
  setMemberActiveAction,
  setMemberRoleAction,
  setProjectRlsEnforceAction,
} from "./actions";
import { ProjectAssignments } from "./ProjectAssignments";

export const dynamic = "force-dynamic";

// Governance roles (D5 mapping) incl. §2.1 sub-roles — the "+suffix" rides on
// the stored Role string; lib/platform/roles.ts parses it.
const ROLES: { value: string; label: string; hint: string }[] = [
  { value: "owner", label: "Owner (Administrator)", hint: "full access incl. finance, approvals, admin" },
  { value: "builder", label: "Builder (Manager)", hint: "read/write + approvals, no finance or admin" },
  { value: "builder+finance", label: "Builder — Finance Manager", hint: "Manager + finance visibility and financial approvals" },
  { value: "architect", label: "Architect (Contributor)", hint: "read/write, no approvals, finance or admin" },
  { value: "broker", label: "Broker (Viewer)", hint: "read-only" },
  { value: "broker+auditor", label: "Broker — Auditor", hint: "read-only incl. finance, whole tenant" },
];

function StatusBanner({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const status = typeof sp.status === "string" ? sp.status : undefined;
  if (!status) return null;
  const who = typeof sp.who === "string" ? sp.who : "";
  const msg = typeof sp.msg === "string" ? sp.msg : "";
  const ok: MessageVariant = "success";
  const warn: MessageVariant = "warning";
  const err: MessageVariant = "danger";
  const map: Record<string, { variant: MessageVariant; text: string }> = {
    invited: { variant: ok, text: `Invitation email sent to ${who}. They'll appear as signed-in once they create their account.` },
    added: { variant: ok, text: `${who} added. No invitation email sent — they either already have an account or auth is not active.` },
    reactivated: { variant: ok, text: `${who} was previously deactivated — access restored with the new role.` },
    already_member: { variant: warn, text: `${who} is already an active member — nothing changed.` },
    role_updated: { variant: ok, text: `Role updated for ${who}.` },
    projects_updated: { variant: ok, text: `Project access updated for ${who}.` },
    rls_enabled: { variant: warn, text: "Project-level access is now ENFORCED — members see only their assigned projects. Owners/Auditors/Business Owners keep full access." },
    rls_disabled: { variant: ok, text: "Project-level access enforcement turned off — all members see every project again." },
    deactivated: { variant: ok, text: `${who} deactivated — access is revoked (takes up to a minute to apply).` },
    reactivated_member: { variant: ok, text: `${who} reactivated.` },
    invalid: { variant: err, text: "Enter a name and a valid email address." },
    error: { variant: err, text: msg || "The change was not applied." },
  };
  const m = map[status];
  if (!m) return null;
  return (
    <MessageBar variant={m.variant} className="mb-4">
      {m.text}
    </MessageBar>
  );
}

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { org } = await params;
  const sp = await searchParams;
  const ctx = await requireOrgCtx(org);
  const me = await requireAdmin(ctx);

  const members = (await listMembers(ctx)).sort(
    (a, b) => Number(b.isActive) - Number(a.isActive) || rolePriority(a.role) - rolePriority(b.role) || a.name.localeCompare(b.name),
  );
  const authOn = clerkEnabled();

  // Project (job) assignments = the RLS access list, from the control plane
  // (PLAT_ASSIGNMENTS on Airtable, PlatCtlAssignment on Postgres).
  const showProjects = controlPlaneEnabled();
  const jobs = showProjects ? await loadJobOptions(ctx) : [];
  const capped = jobs.length >= 200; // loadJobOptions caps the picker at 200
  const assignmentsByEmail = new Map<string, string[]>();
  if (showProjects) {
    for (const a of await listControlAssignments(ctx.orgSlug)) {
      (assignmentsByEmail.get(a.email) ?? assignmentsByEmail.set(a.email, []).get(a.email)!).push(a.jobRecId);
    }
  }
  const enforcing = ctx.config.features?.["project_rls_enforce"] === true;
  // P4 scope preview: active, non-exempt members with no assignments resolve to
  // an empty scope — they'll see nothing once enforcement is on. Surface them so
  // an admin assigns projects before (or notices after) flipping the toggle.
  const lockedOut = showProjects
    ? members.filter(
        (m) =>
          m.isActive &&
          !rlsExempt(m.role) &&
          (assignmentsByEmail.get(m.email.toLowerCase())?.length ?? 0) === 0,
      )
    : [];

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Team & access"
        subtitle="Who can sign in to this organisation, and with which role."
      />

      <StatusBanner sp={sp} />

      {!authOn && (
        <MessageBar variant="warning" className="mb-4">
          Authentication is not active (demo mode) — roles below still govern permissions, but no
          sign-in is required and no invitation emails are sent.
        </MessageBar>
      )}

      <section className="ae-card p-5 mb-6">
        <h2 className="text-base font-semibold mb-3">Invite a member</h2>
        <form action={inviteMemberAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="org" value={ctx.orgSlug} />
          <label className="text-xs text-neutral-600">
            Name
            <input
              name="name"
              required
              className="mt-1 block w-44 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              placeholder="Full name"
            />
          </label>
          <label className="text-xs text-neutral-600">
            Email
            <input
              name="email"
              type="email"
              required
              className="mt-1 block w-60 rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
              placeholder="person@company.com"
            />
          </label>
          <label className="text-xs text-neutral-600">
            Role
            <select
              name="role"
              defaultValue="builder"
              className="mt-1 block rounded-md border border-neutral-300 px-2 py-1.5 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label} — {r.hint}
                </option>
              ))}
            </select>
          </label>
          <SubmitButton
            label={authOn ? "Send invitation" : "Add member"}
            pendingLabel={authOn ? "Sending…" : "Adding…"}
            className={buttonClass("primary")}
          />
        </form>
      </section>

      {showProjects && (
        <section className="ae-card p-5 mb-6">
          <h2 className="text-base font-semibold mb-1">Project-level access (RLS)</h2>
          <p className="text-xs text-neutral-500 mb-3 max-w-2xl">
            {enforcing
              ? "ON — each member sees and edits only the projects assigned to them below. Owners, Auditors and Business Owners always see everything."
              : "Off — every member sees all projects. Assign members to projects below first, then enable this to restrict them (unassigned members will see nothing)."}
          </p>
          {lockedOut.length > 0 ? (
            <MessageBar variant="warning" className="mb-3 max-w-2xl">
              ⚠ {lockedOut.length} active member{lockedOut.length > 1 ? "s" : ""}{" "}
              {enforcing ? "currently see no projects" : "will see no projects once enabled"} — assign
              projects below first: {lockedOut.map((m) => m.name || m.email).join(", ")}.
            </MessageBar>
          ) : (
            <p className="text-xs mb-3 text-ae-success">
              ✓ Every active member is assigned to a project or has full access.
            </p>
          )}
          <form action={setProjectRlsEnforceAction}>
            <input type="hidden" name="org" value={ctx.orgSlug} />
            <input type="hidden" name="enabled" value={enforcing ? "0" : "1"} />
            {enforcing ? (
              <SubmitButton
                label="Disable enforcement"
                pendingLabel="Saving…"
                className={buttonClass("outline")}
              />
            ) : (
              <ConfirmSubmitButton
                label="Enable enforcement"
                confirmLabel="Confirm — restrict members to assigned projects"
                pendingLabel="Saving…"
                className={buttonClass("primary")}
              />
            )}
          </form>
        </section>
      )}

      <section className="ae-card p-5 mb-6">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th scope="col" className="py-1 pr-2">Member</th>
              <th scope="col" className="py-1 pr-2">Role</th>
              {showProjects && <th scope="col" className="py-1 pr-2">Project access</th>}
              <th scope="col" className="py-1 pr-2 text-center">Status</th>
              <th scope="col" className="py-1 text-right">Access</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const self = m.email.toLowerCase() === me.email.toLowerCase();
              return (
                <tr key={m.email} className={`border-t border-neutral-100 align-middle ${m.isActive ? "" : "opacity-50"}`}>
                  <td className="py-2 pr-2">
                    <div className="font-medium">
                      {m.name}
                      {self && <span className="ml-1.5 text-xs font-normal text-neutral-500">(you)</span>}
                    </div>
                    <div className="text-xs text-neutral-500">{m.email}</div>
                  </td>
                  <td className="py-2 pr-2">
                    <form action={setMemberRoleAction} className="flex items-center gap-2">
                      <input type="hidden" name="org" value={ctx.orgSlug} />
                      <input type="hidden" name="email" value={m.email} />
                      <select
                        name="role"
                        defaultValue={m.role}
                        className="rounded-md border border-neutral-300 px-2 py-1 text-xs"
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      <SubmitButton
                        label="Set"
                        pendingLabel="Saving…"
                        className={buttonClass("outline", "sm")}
                      />
                    </form>
                  </td>
                  {showProjects && (
                    <td className="py-2 pr-2 align-top">
                      {rlsExempt(m.role) ? (
                        <span className="text-xs text-neutral-500" title="This role sees every project">
                          Full access
                        </span>
                      ) : (
                        <ProjectAssignments
                          orgSlug={ctx.orgSlug}
                          email={m.email}
                          jobs={jobs}
                          assigned={assignmentsByEmail.get(m.email.toLowerCase()) ?? []}
                          capped={capped}
                        />
                      )}
                    </td>
                  )}
                  <td className="py-2 pr-2 text-center">
                    <Chip variant={m.isActive ? "success" : "neutral"}>
                      {m.isActive ? "active" : "deactivated"}
                    </Chip>
                  </td>
                  <td className="py-2 text-right">
                    <form action={setMemberActiveAction}>
                      <input type="hidden" name="org" value={ctx.orgSlug} />
                      <input type="hidden" name="email" value={m.email} />
                      <input type="hidden" name="active" value={m.isActive ? "0" : "1"} />
                      {m.isActive ? (
                        <ConfirmSubmitButton
                          label="Deactivate"
                          confirmLabel="Confirm deactivate"
                          pendingLabel="Deactivating…"
                          className={buttonClass("outline", "sm")}
                        />
                      ) : (
                        <SubmitButton
                          label="Reactivate"
                          pendingLabel="Reactivating…"
                          className={buttonClass("outline", "sm")}
                        />
                      )}
                    </form>
                  </td>
                </tr>
              );
            })}
            {members.length === 0 && (
              <tr>
                <td colSpan={showProjects ? 5 : 4} className="py-4 text-center text-sm text-neutral-500">
                  No members yet — invite the first one above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <p className="text-xs text-neutral-500 mt-3">
          Membership here is the source of truth for access: a user signs in with their email
          (via Clerk) and must match an active member of this organisation. Deactivating a member
          revokes access without deleting their sign-in account. Every organisation must keep at
          least one active owner.
        </p>
      </section>
    </div>
  );
}
