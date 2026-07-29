// Accounting sync service — connect/sync/disconnect on the provider seam.
// No tokens are persisted (the Xero Custom Connection is env-level); the
// connection row stores status + the latest read-only summary for display.

import { db, prisma } from "@/lib/db";
import { getAccountingProvider } from "@/lib/platform/accounting";
import { OrgCtx } from "@/lib/platform/types";

async function log(ctx: OrgCtx, userName: string, operation: string, result: string, ok: boolean) {
  await db(ctx).platExecutionLog
    .create({
      data: {
        orgId: ctx.orgId,
        actorType: "human",
        actorName: userName,
        operation,
        targetTable: "plat_con_accountingconnection",
        payload: JSON.stringify({ provider: getAccountingProvider().provider }),
        result: result.slice(0, 900),
        status: ok ? "executed" : "failed",
        executedAt: new Date(),
        error: ok ? "" : result.slice(0, 900),
      },
    })
    .catch(() => {});
}

export async function connectAccounting(ctx: OrgCtx, userName: string): Promise<string | null> {
  const provider = getAccountingProvider();
  try {
    const { orgName } = await provider.connect();
    const existing = await db(ctx).platConAccountingConnection.findFirst({
      where: { orgId: ctx.orgId },
    });
    const data = { provider: provider.provider, status: "connected", orgName };
    if (existing) {
      await db(ctx).platConAccountingConnection.update({ where: { id: existing.id }, data });
    } else {
      await db(ctx).platConAccountingConnection.create({ data: { orgId: ctx.orgId, ...data } });
    }
    await log(ctx, userName, "create", `Connected to ${orgName} via ${provider.provider}`, true);
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(ctx, userName, "create", message, false);
    return message;
  }
}

export async function syncAccounting(ctx: OrgCtx, userName: string): Promise<string | null> {
  const provider = getAccountingProvider();
  const connection = await db(ctx).platConAccountingConnection.findFirst({
    where: { orgId: ctx.orgId, status: "connected" },
  });
  if (!connection) return "No connected accounting provider — connect first.";
  try {
    const summary = await provider.fetchSummary();
    await db(ctx).platConAccountingConnection.update({
      where: { id: connection.id },
      data: {
        provider: provider.provider,
        orgName: summary.orgName,
        lastSync: new Date(),
        recordsSynced: summary.invoices.count + summary.bills.count,
        syncLog: JSON.stringify(summary),
      },
    });
    await log(
      ctx,
      userName,
      "update",
      `Synced ${summary.invoices.count} invoices / ${summary.bills.count} bills from ${summary.orgName}${summary.demoMode ? " (demo)" : ""}`,
      true,
    );
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(ctx, userName, "update", message, false);
    return message;
  }
}

export async function disconnectAccounting(ctx: OrgCtx, userName: string): Promise<void> {
  await db(ctx).platConAccountingConnection.updateMany({
    where: { orgId: ctx.orgId },
    data: { status: "disconnected" },
  });
  await log(ctx, userName, "update", "Disconnected accounting provider", true);
}
