// Customer Config reads — Postgres (default) or Airtable when the flag is on.
// Backs the reference dropdowns (budget categories on decisions/new + budget/
// new) and the vendor dropdown (procurement/new), plus the learning-engine
// threshold settings. These are Customer Config tier (PLAT_CFG_* / VENDORS in
// Airtable); onboarding mirrors them into the per-client base (see onboarding).
//
// Transitional resilience: during the Postgres→Airtable cutover an org's config
// may exist only in Postgres (provisioned before the mirror shipped). So the
// Airtable reads fall back to Postgres when the base returns nothing, rather
// than showing an empty dropdown. Once a base is fully seeded the fallback is
// inert.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { STATUS_MAP_REF_TYPE, isAppStatus, normStatusKey, type AppStatus } from "./actionStatus";
import { listOptional } from "./optionalList";
import type { OrgCtx } from "./types";

export interface RefOption {
  id: string;
  name: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Run a transitional Postgres fallback, tolerating a retired database.
 *  Airtable is the system of record now; an Airtable-native org has no
 *  Postgres rows and the server may not even be running (local dev after the
 *  cutover). An empty dropdown beats crashing the whole page render. */
async function pgFallback(label: string, read: () => Promise<RefOption[]>): Promise<RefOption[]> {
  try {
    return await read();
  } catch (e) {
    console.warn(
      `[configSource] ${label}: Postgres fallback unavailable, returning no options —`,
      e instanceof Error ? e.message.trim().split("\n").pop() : e,
    );
    return [];
  }
}

async function referencesFromPostgres(ctx: OrgCtx, type: string): Promise<RefOption[]> {
  const rows = await db(ctx).platCfgReference.findMany({
    where: { orgId: ctx.orgId, type, isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  return rows.map((r) => ({ id: String(r.id), name: r.name }));
}

/** Reference values of a given type (e.g. "budget_category") for a picker. */
export async function loadReferenceOptions(ctx: OrgCtx, type: string): Promise<RefOption[]> {
  if (!airtableEnabled(ctx)) return referencesFromPostgres(ctx, type);
  const rows = await core.list(ctx.orgSlug, "PLAT_CFG_REFERENCE", { maxRecords: 500 });
  const out = rows
    .filter((r) => str(r["Ref_Type"]) === type && r["Is_Active"] !== false)
    .sort((a, b) => num(a["Sort_Order"]) - num(b["Sort_Order"]))
    .map((r) => ({ id: r.id, name: str(r["Name"]) }))
    .filter((o) => o.name);
  // Transitional fallback: base not yet seeded → use Postgres so the dropdown
  // isn't empty for an org provisioned before the config mirror.
  return out.length ? out : pgFallback(`references:${type}`, () => referencesFromPostgres(ctx, type));
}

async function vendorsFromPostgres(ctx: OrgCtx): Promise<RefOption[]> {
  const rows = await db(ctx).platConVendor.findMany({
    where: { orgId: ctx.orgId, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((v) => ({ id: String(v.id), name: v.name }));
}

/** Active vendors for the procurement vendor picker. VENDORS comes from the
 *  vertical template clone — not the app-runtime top-up — so a base supplied
 *  via the existing-base-id path can lack it entirely; read it as optional.
 *  (PLAT_CFG_* don't need this: ensureAppRuntimeTables creates them on every
 *  onboarding path, supplied bases included.) */
export async function loadVendorOptions(ctx: OrgCtx): Promise<RefOption[]> {
  if (!airtableEnabled(ctx)) return vendorsFromPostgres(ctx);
  const rows = await listOptional(ctx.orgSlug, "VENDORS", { maxRecords: 500 });
  const out = rows
    .filter((v) => v["Is_Active"] !== false)
    .map((v) => ({ id: v.id, name: str(v["Vendor_Name"]) }))
    .filter((o) => o.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  return out.length ? out : pgFallback("vendors", () => vendorsFromPostgres(ctx));
}

/** Per-org raw→canonical action-status mappings (the cleanup translation layer
 *  for migrated bases with a messy Status vocabulary). Keyed by normalised raw
 *  value. An empty map is valid — it just means nothing's been mapped yet, so
 *  unknown statuses stay flagged rather than silently miscounted. */
async function statusMapFromPostgres(ctx: OrgCtx): Promise<Map<string, AppStatus>> {
  const rows = await db(ctx).platCfgReference.findMany({
    where: { orgId: ctx.orgId, type: STATUS_MAP_REF_TYPE, isActive: true },
  });
  const map = new Map<string, AppStatus>();
  for (const r of rows) {
    const value = str(r.value);
    if (isAppStatus(value)) map.set(r.code || normStatusKey(r.name), value);
  }
  return map;
}

export async function loadActionStatusMap(ctx: OrgCtx): Promise<Map<string, AppStatus>> {
  if (!airtableEnabled(ctx)) return statusMapFromPostgres(ctx);
  const rows = await core.list(ctx.orgSlug, "PLAT_CFG_REFERENCE", { maxRecords: 500 });
  const map = new Map<string, AppStatus>();
  for (const r of rows) {
    if (str(r["Ref_Type"]) !== STATUS_MAP_REF_TYPE || r["Is_Active"] === false) continue;
    const value = str(r["Value"]);
    if (isAppStatus(value)) map.set(str(r["Code"]) || normStatusKey(str(r["Name"])), value);
  }
  return map;
}

export function loadTradeOptions(ctx: OrgCtx): Promise<RefOption[]> {
  return loadReferenceOptions(ctx, "trade_item");
}

export function loadClientPriorityOptions(ctx: OrgCtx): Promise<RefOption[]> {
  return loadReferenceOptions(ctx, "client_priority");
}
