// Accounting — Stage-1 "read first" integration. Real Xero (Custom
// Connection) when XERO_CLIENT_ID/SECRET are configured; demo ledger
// otherwise. Read-only: nothing is ever written back to the ledger.

import { db, prisma } from "@/lib/db";
import { MetricCard, PageHeader, StatusBadge } from "@/components/PageHeader";
import { ConfirmSubmitButton } from "@/components/form/ConfirmSubmitButton";
import { SubmitButton } from "@/components/form/SubmitButton";
import { buttonClass } from "@/components/ui/Button";
import { MessageBar } from "@/components/ui/MessageBar";
import { currency, formatDate } from "@/lib/format";
import { xeroEnabled, type AccountingSummary } from "@/lib/platform/accounting";
import { requireFinancialAccess, requireOrgCtx } from "@/lib/platform/org-context";
import {
  connectAccountingAction,
  disconnectAccountingAction,
  syncAccountingAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function AccountingPage({
  params,
  searchParams,
}: {
  params: Promise<{ org: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const ctx = await requireOrgCtx((await params).org);
  await requireFinancialAccess(ctx);
  if (!ctx.config.features.accounting) {
    return (
      <div className="p-6 max-w-3xl">
        <PageHeader
          title="Accounting"
          subtitle="Accounting integration is disabled for this organisation."
        />
      </div>
    );
  }
  const { error } = await searchParams;
  const connection = await db(ctx).platConAccountingConnection.findFirst({
    where: { orgId: ctx.orgId },
  });

  let summary: AccountingSummary | null = null;
  if (connection?.syncLog) {
    try {
      summary = JSON.parse(connection.syncLog);
    } catch {
      summary = null;
    }
  }
  const live = xeroEnabled();
  const connected = connection?.status === "connected";

  return (
    <div className="p-6 max-w-3xl">
      <PageHeader
        title="Accounting"
        subtitle={
          live
            ? "Xero Custom Connection configured — reads are live. Nothing is written back to the ledger."
            : "No Xero credentials configured — the demo ledger stands in. Set XERO_CLIENT_ID/SECRET to go live."
        }
      />
      {error && (
        <MessageBar variant="danger" className="mb-4">
          {error}
        </MessageBar>
      )}

      <section className="ae-card p-5 mb-6">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-semibold capitalize">
              {connection ? `${connection.provider} — ${connection.orgName || "…"}` : "Not connected"}
            </h2>
            <p className="text-xs text-neutral-500">
              {connection?.lastSync
                ? `Last sync ${formatDate(connection.lastSync)} · ${connection.recordsSynced} records`
                : "Never synced"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {connection && <StatusBadge status={connection.status} />}
            {!connected ? (
              <form action={connectAccountingAction}>
                <input type="hidden" name="org" value={ctx.orgSlug} />
                <SubmitButton
                  label={`Connect ${live ? "Xero" : "demo ledger"}`}
                  pendingLabel="Connecting…"
                />
              </form>
            ) : (
              <>
                <form action={syncAccountingAction}>
                  <input type="hidden" name="org" value={ctx.orgSlug} />
                  <SubmitButton label="Sync now" pendingLabel="Syncing…" />
                </form>
                <form action={disconnectAccountingAction}>
                  <input type="hidden" name="org" value={ctx.orgSlug} />
                  <ConfirmSubmitButton
                    label="Disconnect"
                    confirmLabel="Confirm disconnect"
                    pendingLabel="Disconnecting…"
                    className={buttonClass("danger")}
                  />
                </form>
              </>
            )}
          </div>
        </div>
      </section>

      {connected && !summary && (
        <section className="ae-card p-5 text-sm text-neutral-600">
          Connected — no data synced yet. Run a sync to pull invoices and bills.
        </section>
      )}

      {summary && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
            <MetricCard value={summary.invoices.count} label="Invoices (latest page)" />
            <MetricCard value={currency(summary.invoices.outstanding)} label="Invoices outstanding" />
            <MetricCard value={summary.bills.count} label="Bills" />
            <MetricCard value={currency(summary.bills.outstanding)} label="Bills outstanding" />
          </div>
          <section className="ae-card p-5">
            <h2 className="text-base font-semibold mb-3">
              Recent invoices{summary.demoMode ? " (demo data)" : ""}
            </h2>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-neutral-500">
                <tr>
                  <th scope="col" className="py-1 pr-2">Number</th>
                  <th scope="col" className="py-1 pr-2">Contact</th>
                  <th scope="col" className="py-1 pr-2 text-right">Total</th>
                  <th scope="col" className="py-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {summary.sample.map((row, i) => (
                  <tr key={i} className="border-t border-neutral-100">
                    <td className="py-2 pr-2 font-mono text-xs">{row.number}</td>
                    <td className="py-2 pr-2">{row.contact}</td>
                    <td className="py-2 pr-2 text-right whitespace-nowrap">{currency(row.total)}</td>
                    <td className="py-2 text-xs">{row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
