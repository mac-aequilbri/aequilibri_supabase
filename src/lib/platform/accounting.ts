// Accounting provider seam — Stage-1 "read first" integration from the doc.
// Real implementation: Xero via a Custom Connection (OAuth2 client
// credentials, machine-to-machine — no per-org token storage, so nothing
// sensitive lands in the database). Demo implementation keeps the platform
// fully usable without credentials.
//
// Activation: XERO_CLIENT_ID + XERO_CLIENT_SECRET (a Xero "Custom Connection"
// app with accounting.transactions.read + accounting.settings.read scopes).
// The per-org authorization-code flow (each customer connecting their own
// Xero) is the next step on this same interface.

import { db, prisma } from "@/lib/db";
import { encryptSecret, decryptSecret } from "./crypto";
import type { OrgCtx } from "./types";

export interface AccountingSummary {
  orgName: string;
  invoices: { count: number; total: number; outstanding: number };
  bills: { count: number; total: number; outstanding: number };
  sample: { number: string; contact: string; total: number; status: string }[];
  demoMode: boolean;
}

export interface AccountingProvider {
  provider: string;
  /** Verify credentials and return the connected accounting org's name. */
  connect(): Promise<{ orgName: string }>;
  fetchSummary(): Promise<AccountingSummary>;
}

export function xeroEnabled(): boolean {
  return !!(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET);
}

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
let cachedXero: { token: string; expiresAt: number } | null = null;

async function xeroToken(): Promise<string> {
  if (cachedXero && cachedXero.expiresAt > Date.now() + 60_000) return cachedXero.token;
  const basic = Buffer.from(
    `${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "accounting.transactions.read accounting.settings.read",
    }),
  });
  if (!res.ok) throw new Error(`Xero token exchange failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedXero = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedXero.token;
}

async function xeroGet<T>(path: string, tenantId?: string): Promise<T> {
  const token = await xeroToken();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: "application/json",
  };
  if (tenantId) headers["xero-tenant-id"] = tenantId;
  const res = await fetch(`https://api.xero.com${path}`, { headers });
  if (!res.ok) throw new Error(`Xero GET ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface XeroInvoice {
  InvoiceNumber?: string;
  Type: "ACCREC" | "ACCPAY";
  Status: string;
  Total?: number;
  AmountDue?: number;
  Contact?: { Name?: string };
}

class XeroProvider implements AccountingProvider {
  provider = "xero";

  private async tenant(): Promise<{ tenantId: string; tenantName: string }> {
    // Client-credentials tokens are bound to exactly one Xero organisation.
    const connections = await xeroGet<{ tenantId: string; tenantName: string }[]>("/connections");
    if (!connections.length) throw new Error("Xero app has no connected organisation.");
    return connections[0];
  }

  async connect(): Promise<{ orgName: string }> {
    const t = await this.tenant();
    return { orgName: t.tenantName };
  }

  async fetchSummary(): Promise<AccountingSummary> {
    const t = await this.tenant();
    // First page (100 invoices/bills) is plenty for the enrichment summary.
    const data = await xeroGet<{ Invoices: XeroInvoice[] }>(
      "/api.xro/2.0/Invoices?page=1&order=Date%20DESC",
      t.tenantId,
    );
    const agg = (type: "ACCREC" | "ACCPAY") => {
      const rows = data.Invoices.filter((i) => i.Type === type);
      return {
        count: rows.length,
        total: Math.round(rows.reduce((s, i) => s + (i.Total ?? 0), 0) * 100) / 100,
        outstanding: Math.round(rows.reduce((s, i) => s + (i.AmountDue ?? 0), 0) * 100) / 100,
      };
    };
    return {
      orgName: t.tenantName,
      invoices: agg("ACCREC"),
      bills: agg("ACCPAY"),
      sample: data.Invoices.slice(0, 5).map((i) => ({
        number: i.InvoiceNumber ?? "—",
        contact: i.Contact?.Name ?? "—",
        total: i.Total ?? 0,
        status: i.Status,
      })),
      demoMode: false,
    };
  }
}

class DemoProvider implements AccountingProvider {
  provider = "demo";

  async connect(): Promise<{ orgName: string }> {
    return { orgName: "Demo Ledger Pty Ltd" };
  }

  async fetchSummary(): Promise<AccountingSummary> {
    return {
      orgName: "Demo Ledger Pty Ltd",
      invoices: { count: 42, total: 612400, outstanding: 84300 },
      bills: { count: 18, total: 238900, outstanding: 31200 },
      sample: [
        { number: "INV-0042", contact: "Riverview Developments", total: 96800, status: "AUTHORISED" },
        { number: "INV-0041", contact: "Ocean St Holdings", total: 28400, status: "PAID" },
      ],
      demoMode: true,
    };
  }
}

/** Real Xero when credentials are configured, demo ledger otherwise. */
export function getAccountingProvider(): AccountingProvider {
  return xeroEnabled() ? new XeroProvider() : new DemoProvider();
}

// ── Per-org token storage (encrypted at rest) ──────────────────────────────
// The documented next step is per-customer Xero via the authorization-code
// flow, where each org connects its own ledger and we hold that org's OAuth
// token. Those tokens are encrypted with crypto.ts before they touch the DB and
// decrypted only in memory at use — the `access_token` column never holds
// plaintext. Scoped to orgId, so one org can never read another's token.

/** Persist an org's accounting OAuth token, encrypted at rest. */
export async function saveAccountingToken(
  ctx: OrgCtx,
  provider: string,
  token: string,
  orgName = "",
): Promise<void> {
  const encrypted = encryptSecret(token);
  const existing = await db(ctx).platConAccountingConnection.findFirst({
    where: { orgId: ctx.orgId },
  });
  if (existing) {
    await db(ctx).platConAccountingConnection.update({
      where: { id: existing.id },
      data: { provider, status: "connected", accessToken: encrypted, orgName },
    });
  } else {
    await db(ctx).platConAccountingConnection.create({
      data: { orgId: ctx.orgId, provider, status: "connected", accessToken: encrypted, orgName },
    });
  }
}

/** Decrypt and return an org's accounting token, or null if none/unreadable.
 *  A decrypt failure (tamper, key rotation, legacy plaintext) fails closed. */
export async function loadAccountingToken(ctx: OrgCtx): Promise<string | null> {
  const conn = await db(ctx).platConAccountingConnection.findFirst({
    where: { orgId: ctx.orgId },
  });
  if (!conn || !conn.accessToken) return null;
  try {
    return decryptSecret(conn.accessToken);
  } catch {
    return null;
  }
}
