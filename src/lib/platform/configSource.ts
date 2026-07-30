// Customer Config reads — Postgres. Backs the reference dropdowns (budget
// categories on decisions/new + budget/new) and the vendor dropdown
// (procurement/new), plus the learning-engine threshold settings.

import { db, prisma } from "@/lib/db";
import { STATUS_MAP_REF_TYPE, isAppStatus, normStatusKey, type AppStatus } from "./actionStatus";
import type { OrgCtx } from "./types";

export interface RefOption {
  id: string;
  name: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
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
  return referencesFromPostgres(ctx, type);
}

async function vendorsFromPostgres(ctx: OrgCtx): Promise<RefOption[]> {
  const rows = await db(ctx).platConVendor.findMany({
    where: { orgId: ctx.orgId, isActive: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return rows.map((v) => ({ id: String(v.id), name: v.name }));
}

/** Active vendors for the procurement vendor picker. */
export async function loadVendorOptions(ctx: OrgCtx): Promise<RefOption[]> {
  return vendorsFromPostgres(ctx);
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
  return statusMapFromPostgres(ctx);
}

export function loadTradeOptions(ctx: OrgCtx): Promise<RefOption[]> {
  return loadReferenceOptions(ctx, "trade_item");
}

export function loadClientPriorityOptions(ctx: OrgCtx): Promise<RefOption[]> {
  return loadReferenceOptions(ctx, "client_priority");
}
