// Idempotent, fail-safe demo seed. Runs in the Render build AFTER `prisma db
// push`, so the freshly-provisioned Postgres has enough data to demo every UC.
//
//  - Idempotent: each block only seeds when its table is empty, so re-running
//    on every deploy is a no-op once data exists (and never duplicates rows).
//  - Fail-safe: any error is logged and swallowed; the script always exits 0 so
//    a seed problem can never break a deploy.
//
// Run locally with the dev client:  node prisma/seed.mjs

import { PrismaClient } from "@prisma/client";
// §2b split: org registry + control-plane team rows go to the CONTROL database.
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";
import { seedPlatform } from "./seed-platform.mjs";

const prisma = new PrismaClient();
const controlDb = new ControlPrismaClient();

async function seedIfEmpty(label, model, rows) {
  try {
    const count = await model.count();
    if (count > 0) {
      console.log(`  · ${label}: ${count} rows already present — skipped`);
      return;
    }
    await model.createMany({ data: rows });
    console.log(`  ✓ ${label}: seeded ${rows.length}`);
  } catch (err) {
    console.log(`  ! ${label}: skipped (${err?.message ?? err})`);
  }
}

async function main() {
  // Demo data must never land in a database holding real customer data:
  // seeding is opt-in (locally NODE_ENV is unset, so dev still seeds freely).
  if (process.env.NODE_ENV === "production" && process.env.SEED_DEMO_DATA !== "true") {
    console.log("Seed skipped (SEED_DEMO_DATA not set).");
    return;
  }
  console.log("Seeding demo data (idempotent)…");

  // ── UC1 — config tables ────────────────────────────────────────────────────
  await seedIfEmpty("uc1 rate cards", prisma.uc1RateCard, [
    { material: "colorbond", pitchType: "standard", description: "Colorbond Steel — standard pitch", unit: "m²", rateExGst: 120 },
    { material: "colorbond", pitchType: "steep", description: "Colorbond Steel — steep pitch", unit: "m²", rateExGst: 138 },
    { material: "terracotta", pitchType: "standard", description: "Terracotta Tiles — standard pitch", unit: "m²", rateExGst: 150 },
    { material: "concrete", pitchType: "standard", description: "Concrete Tiles — standard pitch", unit: "m²", rateExGst: 135 },
  ]);

  await seedIfEmpty("uc1 guttering rates", prisma.uc1GutteringRate, [
    { itemType: "gutter", description: "Colorbond 150mm quad gutter", unit: "lm", rateExGst: 100 },
    { itemType: "downpipe", description: "90mm PVC downpipe", unit: "each", rateExGst: 250 },
    { itemType: "valley", description: "Valley iron", unit: "lm", rateExGst: 45 },
    { itemType: "ridge_cap", description: "Ridge capping", unit: "lm", rateExGst: 35 },
  ]);

  await seedIfEmpty("uc1 finance providers", prisma.uc1FinanceProvider, [
    { name: "Brighte", slug: "brighte", interestRatePct: 0, minTermMonths: 12, maxTermMonths: 24, minAmount: 1000, tagline: "0% interest-free for 24 months" },
    { name: "Humm", slug: "humm", interestRatePct: 9.95, minTermMonths: 12, maxTermMonths: 60, minAmount: 2000, tagline: "Flexible terms up to 5 years" },
  ]);

  await seedIfEmpty("uc1 solar partners", prisma.uc1SolarPartner, [
    { name: "Sunshine Coast Solar", contactName: "Dana Reyes", contactEmail: "leads@scsolar.example", referralFeePct: 10, avgInstallValue: 12000 },
  ]);

  // Vendors + their material prices (vendor material price needs vendorId).
  try {
    if ((await prisma.uc1Vendor.count()) === 0) {
      const v1 = await prisma.uc1Vendor.create({ data: { name: "Townsville Steel Supplies", suburb: "Garbutt", state: "QLD", isPreferred: true } });
      const v2 = await prisma.uc1Vendor.create({ data: { name: "Reef Roofing Supplies", suburb: "Aitkenvale", state: "QLD" } });
      await prisma.uc1VendorMaterialPrice.createMany({
        data: [
          { vendorId: v1.id, material: "colorbond", description: ".48 BMT Colorbond sheet", unit: "m²", unitPriceExGst: 38, leadDays: 3 },
          { vendorId: v1.id, material: "zincalume", description: ".48 BMT Zincalume sheet", unit: "m²", unitPriceExGst: 33, leadDays: 3 },
          { vendorId: v2.id, material: "colorbond", description: "Colorbond Ultra sheet", unit: "m²", unitPriceExGst: 41, leadDays: 5 },
          { vendorId: v2.id, material: "terracotta", description: "Terracotta tile (each)", unit: "each", unitPriceExGst: 2.4, leadDays: 7 },
        ],
      });
      console.log("  ✓ uc1 vendors + prices: seeded 2 vendors / 4 prices");
    } else {
      console.log("  · uc1 vendors already present — skipped");
    }
  } catch (err) {
    console.log(`  ! uc1 vendors: skipped (${err?.message ?? err})`);
  }

  // ── Platform (Plat*) — three demo organisations on the shared core ─────────
  // (UC2/UC3 were rebuilt onto this core; their old seed blocks are gone.)
  await seedPlatform(prisma, controlDb);

  console.log("Seed complete.");
}

main()
  .catch((err) => console.log(`Seed error (ignored): ${err?.message ?? err}`))
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    await controlDb.$disconnect().catch(() => {});
    process.exit(0); // never fail the build on seed problems
  });
