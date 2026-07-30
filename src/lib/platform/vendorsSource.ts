// Vendors data source — Postgres. Org-level list, no job scoping. Same
// per-page loader pattern as the other migrated pages.

import { db, prisma } from "@/lib/db";
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

/** Load the vendor registry. */
export function loadVendors(ctx: OrgCtx): Promise<VendorView[]> {
  return fromPostgres(ctx);
}

/** Form-ready values for a single vendor's edit page. Null if not in this org. */
export async function loadVendorDetail(ctx: OrgCtx, id: string): Promise<EditorValues | null> {
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
