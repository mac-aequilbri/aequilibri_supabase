// Vendors data source — Postgres (default) or the Airtable VENDORS table
// (Domain Extension) when AIRTABLE_MIGRATION is enabled. Org-level list, no job
// scoping. Same per-page loader pattern as the other migrated pages.
//
// VENDORS is an optional table: bases that predate the spec-12 provisioning
// don't have it, so the list read must tolerate the missing-table 403.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { listOptional } from "./optionalList";
import type { EditorValues } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface VendorView {
  id: string;
  name: string;
  category: string;
  contactName: string;
  contactEmail: string;
  rating: number;
  isActive: boolean;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function fromPostgres(ctx: OrgCtx): Promise<VendorView[]> {
  const vendors = await db(ctx).platConVendor.findMany({
    where: { orgId: ctx.orgId },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  return vendors.map((v) => ({
    id: String(v.id),
    name: v.name,
    category: v.category,
    contactName: v.contactName,
    contactEmail: v.contactEmail,
    rating: v.rating,
    isActive: v.isActive,
  }));
}

async function fromAirtable(ctx: OrgCtx): Promise<VendorView[]> {
  const rows = await listOptional(ctx.orgSlug, "VENDORS", { maxRecords: 200 });
  return rows.map((r) => ({
    id: r.id,
    name: str(r["Vendor_Name"]) || "(unnamed vendor)",
    category: str(r["Category"]),
    contactName: str(r["Contact_Name"]),
    contactEmail: str(r["Contact_Email"]),
    rating: typeof r["Rating"] === "number" ? (r["Rating"] as number) : 0,
    isActive: r["Is_Active"] === true,
  }));
}

/** Load the vendor registry from whichever backend is active. */
export function loadVendors(ctx: OrgCtx): Promise<VendorView[]> {
  return airtableEnabled(ctx) ? fromAirtable(ctx) : fromPostgres(ctx);
}

/** Form-ready values for a single vendor's edit page. Null if not in this org. */
export async function loadVendorDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
  if (airtableEnabled(ctx)) {
    let r: Record<string, unknown> | null = null;
    try {
      r = await core.get(ctx.orgSlug, "VENDORS", id);
    } catch {
      return null;
    }
    if (!r) return null;
    return {
      name: str(r["Vendor_Name"]),
      category: str(r["Category"]),
      contactName: str(r["Contact_Name"]),
      contactEmail: str(r["Contact_Email"]),
      contactPhone: str(r["Contact_Phone"]),
      rating: typeof r["Rating"] === "number" ? (r["Rating"] as number) : 5,
      notes: str(r["Notes"]),
      isActive: r["Is_Active"] === true,
    };
  }
  const v = await db(ctx).platConVendor.findFirst({ where: { id: Number(id), orgId: ctx.orgId } });
  if (!v) return null;
  return {
    name: v.name,
    category: v.category,
    contactName: v.contactName,
    contactEmail: v.contactEmail,
    contactPhone: v.contactPhone,
    rating: v.rating,
    notes: v.notes,
    isActive: v.isActive,
  };
}
