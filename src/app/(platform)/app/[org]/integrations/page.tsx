// Per-org integration registry (Module 2 connectivity). Lists the channels
// wired for this org, their enable state + delivery health, and how to point an
// n8n workflow at the inbound webhook. Admin (owner) only.

import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { ConfirmSubmitButton } from "@/components/form/ConfirmSubmitButton";
import { SubmitButton } from "@/components/form/SubmitButton";
import { buttonClass } from "@/components/ui/Button";
import { Chip, type ChipVariant } from "@/components/ui/Chip";
import { MessageBar } from "@/components/ui/MessageBar";
import { getOrgWebhookSecret, listConnections, listOutbox } from "@/lib/platform/controlPlane";
import { requireAdmin, requireOrgCtx } from "@/lib/platform/org-context";
import { addConnection, removeConnection, toggleConnection } from "./actions";

export const dynamic = "force-dynamic";

const CHANNELS = ["email", "slack", "form", "drive", "webhook"];

/** Outbound-event delivery status → chip tone (delivered good, failed retrying,
 *  dead needs attention). Presentational only. */
function outboxVariant(status: string): ChipVariant {
  if (/delivered|ok/i.test(status)) return "success";
  if (/dead/i.test(status)) return "danger";
  if (/failed|error/i.test(status)) return "warning";
  return "neutral";
}

export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ org: string }>;
}) {
  const { org } = await params;
  const ctx = await requireOrgCtx(org);
  await requireAdmin(ctx);
  const rows = await listConnections(ctx.orgSlug);
  const outbox = await listOutbox(ctx.orgSlug);
  // Admin-only page (requireAdmin above) — safe to surface the signing secret.
  const webhookSecret = await getOrgWebhookSecret(ctx.orgSlug);

  // Delivery-health roll-up. lastStatus is free text written by
  // touchConnectionHealth ("ok", "ok (deduped)", "error: …"); outbound retry
  // states use failed/dead — treat any of those as unhealthy.
  const unhealthy = rows.filter((r) => /error|failed|dead/i.test(r.lastStatus)).length;
  const exampleBody = `{ "orgSlug": "${ctx.orgSlug}", "channel": "email", "externalId": "<provider message id>", "from": "", "subject": "", "body": "", "attachments": [] }`;

  return (
    <main className="max-w-3xl mx-auto px-6 py-10">
      <PageHeader
        title="Integrations"
        subtitle="External channels wired to this organisation via n8n. Enable a channel here before pointing an n8n workflow at the inbound webhook."
      />

      {rows.length === 0 ? (
        <p className="text-sm text-neutral-600">No channels wired yet. Add one below.</p>
      ) : (
        <>
        <MessageBar variant={unhealthy > 0 ? "warning" : "success"} className="mb-3">
          {rows.length} channel{rows.length === 1 ? "" : "s"} ·{" "}
          {unhealthy > 0 ? `${unhealthy} with failures` : "all healthy"}
        </MessageBar>
        <table className="w-full text-sm ae-card">
          <thead className="text-left text-xs text-neutral-500">
            <tr>
              <th scope="col" className="p-3">Channel</th>
              <th scope="col" className="p-3">Direction</th>
              <th scope="col" className="p-3">Enabled</th>
              <th scope="col" className="p-3">Last event</th>
              <th scope="col" className="p-3">Credential</th>
              <th scope="col" className="p-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.recordId} className="border-t border-neutral-100">
                <td className="p-3 font-medium">{r.channel}</td>
                <td className="p-3 font-mono text-xs">{r.direction}</td>
                <td className="p-3">
                  <form action={toggleConnection} className="inline">
                    <input type="hidden" name="org" value={ctx.orgSlug} />
                    <input type="hidden" name="recordId" value={r.recordId} />
                    <input type="hidden" name="isActive" value={String(r.isActive)} />
                    <SubmitButton
                      label={r.isActive ? "Enabled" : "Disabled"}
                      pendingLabel="Updating…"
                      className={buttonClass("ghost", "sm", r.isActive ? "" : "opacity-60")}
                    />
                  </form>
                </td>
                <td className="p-3 text-xs">
                  {r.lastEventAt ? (
                    <span>
                      {r.lastEventAt.slice(0, 19).replace("T", " ")}
                      <span className="block text-neutral-500">{r.lastStatus || "—"}</span>
                    </span>
                  ) : (
                    <span className="text-neutral-500">never</span>
                  )}
                </td>
                <td className="p-3 font-mono text-xs">{r.credentialRef || "—"}</td>
                <td className="p-3 text-right">
                  <form action={removeConnection} className="inline">
                    <input type="hidden" name="org" value={ctx.orgSlug} />
                    <input type="hidden" name="recordId" value={r.recordId} />
                    <ConfirmSubmitButton
                      label="🗑 Delete"
                      confirmLabel="Confirm delete"
                      pendingLabel="Deleting…"
                      className={buttonClass("danger", "sm")}
                    />
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
      )}

      <section className="mt-8 ae-card p-5">
        <h2 className="text-base font-semibold mb-3">Add a channel</h2>
        <form action={addConnection} className="flex flex-wrap items-end gap-3 text-sm">
          <input type="hidden" name="org" value={ctx.orgSlug} />
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Channel</span>
            <select name="channel" className="border rounded px-2 py-1" defaultValue="email">
              {CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Direction</span>
            <select name="direction" className="border rounded px-2 py-1" defaultValue="in">
              <option value="in">in (ingest)</option>
              <option value="out">out (deliver)</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Credential ref (n8n)</span>
            <input name="credentialRef" className="border rounded px-2 py-1" placeholder="n8n:gmail-dulong" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Event filter (optional)</span>
            <input name="eventFilter" className="border rounded px-2 py-1" placeholder="quote,invoice" />
          </label>
          <SubmitButton label="Add" pendingLabel="Adding…" />
        </form>
      </section>

      <section className="mt-8 ae-card p-5 text-sm">
        <h2 className="font-semibold mb-2">Connect via n8n</h2>
        <p className="text-neutral-600 mb-3">
          Point an n8n workflow (Gmail trigger, Slack event, Drive change, web form) at the inbound webhook.
          Only channels with an <strong>enabled inbound connection</strong> above are accepted.
        </p>
        <dl className="space-y-2 text-xs">
          <div>
            <dt className="text-neutral-500">Endpoint</dt>
            <dd className="font-mono flex flex-wrap items-center gap-2">
              POST /api/platform/hooks
              <CopyButton path="/api/platform/hooks" label="Copy URL" title="Copy the full endpoint URL" />
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">Headers</dt>
            <dd className="font-mono">
              X-Aequilibri-Timestamp: &lt;unix seconds&gt;
              <br />
              X-Aequilibri-Signature: sha256=&lt;hex&gt;
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">Signature</dt>
            <dd className="font-mono">HMAC-SHA256( orgSecret, `${"{timestamp}"}.${"{rawBody}"}` )</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Body</dt>
            <dd className="font-mono flex flex-wrap items-center gap-2">
              <span className="break-all">{exampleBody}</span>
              <CopyButton value={exampleBody} label="Copy body" title="Copy the example request body" />
            </dd>
            <dd className="text-neutral-500 mt-0.5">
              from / subject / body / attachments are optional.
            </dd>
          </div>
          {webhookSecret && (
            <div>
              <dt className="text-neutral-500">Signing secret</dt>
              <dd className="font-mono flex flex-wrap items-center gap-2">
                <span>••••••••{webhookSecret.slice(-4)}</span>
                <CopyButton value={webhookSecret} label="Copy secret" title="Copy the full signing secret" />
              </dd>
            </div>
          )}
        </dl>
        <p className="text-neutral-500 mt-3 text-xs">
          {webhookSecret
            ? "The signing secret is managed in the control base for now; a rotate-from-UI control is planned."
            : "No signing secret is set for this org yet — set one in the org registry settings (setOrgWebhookSecret)."}{" "}
          Provider credentials (OAuth tokens) live in n8n — never here.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold mb-3">Recent outbound events</h2>
        {outbox.length === 0 ? (
          <p className="text-sm text-neutral-600">
            No outbound events yet. Events are enqueued (a proposal is approved, a report is sent, an assessment is
            accepted) only when an <strong>outbound</strong> connection is active; n8n delivers them.
          </p>
        ) : (
          <table className="w-full text-sm ae-card">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th scope="col" className="p-3">Event</th>
                <th scope="col" className="p-3">Status</th>
                <th scope="col" className="p-3">Created</th>
                <th scope="col" className="p-3">Delivered</th>
              </tr>
            </thead>
            <tbody>
              {outbox.map((e) => (
                <tr key={e.recordId} className="border-t border-neutral-100">
                  <td className="p-3 font-mono text-xs">
                    {e.event}
                    {e.summary ? <span className="block text-neutral-500 font-sans">{e.summary}</span> : null}
                  </td>
                  <td className="p-3 text-xs">
                    <Chip variant={outboxVariant(e.status)}>{e.status}</Chip>
                  </td>
                  <td className="p-3 text-xs">{e.createdAt.slice(0, 19).replace("T", " ") || "—"}</td>
                  <td className="p-3 text-xs">{e.deliveredAt ? e.deliveredAt.slice(0, 19).replace("T", " ") : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-xs text-neutral-500">
          Failed events are retried automatically each scheduler run; <strong>dead</strong> = exceeded max retries
          and needs attention.
        </p>
      </section>
    </main>
  );
}
