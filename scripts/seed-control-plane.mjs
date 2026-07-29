// Seed a fresh Postgres control plane (migration-plan Phase 3.7) so dev or
// staging boots with zero Airtable involvement:
//   - the org registry row (PlatOrganisation)
//   - an owner team member (PlatCtlTeamMember — the control-plane team store)
//   - the curated job catalogs (PlatCtlJobCatalog, from job-catalog-seed.json)
//
// Idempotent: existing org/member/catalog rows are left alone, so it is safe
// to re-run. Usage:
//
//   node scripts/seed-control-plane.mjs --slug acme --name "Acme Constructions" \
//        --admin-email you@example.com [--admin-name "You"] [--vertical construction]
//
// Omit --slug to seed only the job catalogs.

import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const slug = arg("slug");
const name = arg("name", slug);
const adminEmail = arg("admin-email");
const adminName = arg("admin-name", adminEmail ? adminEmail.split("@")[0] : null);
const vertical = arg("vertical", "construction");

// ── Job catalogs (global, per vertical) ─────────────────────────────────────
const seed = JSON.parse(readFileSync(new URL("./job-catalog-seed.json", import.meta.url), "utf8"));
for (const [verticalKey, entries] of Object.entries(seed)) {
  const existing = await prisma.platCtlJobCatalog.count({ where: { verticalKey } });
  if (existing > 0) {
    console.log(`- job catalog '${verticalKey}': ${existing} rows already present, skipped`);
    continue;
  }
  await prisma.platCtlJobCatalog.createMany({
    data: entries.map((e, i) => ({
      verticalKey,
      key: e.key,
      label: e.label,
      categoryGroup: e.group ?? "",
      engagementType: e.engagementType ?? "short_job",
      scopeHint: e.scopeHint ?? "",
      phases: JSON.stringify(e.phases ?? []),
      sortOrder: i,
      source: "curated",
    })),
  });
  console.log(`- job catalog '${verticalKey}': seeded ${entries.length} rows`);
}

// ── Org + owner ─────────────────────────────────────────────────────────────
if (slug) {
  let org = await prisma.platOrganisation.findFirst({ where: { slug } });
  if (org) {
    console.log(`- org '${slug}': already exists (id ${org.id})`);
  } else {
    org = await prisma.platOrganisation.create({
      data: {
        slug,
        name: name ?? slug,
        vertical,
        allowedEngagementTypes: JSON.stringify(["long_project"]),
      },
    });
    console.log(`- org '${slug}': created (id ${org.id})`);
  }
  if (adminEmail) {
    const member = await prisma.platCtlTeamMember.findFirst({
      where: { orgSlug: slug, email: adminEmail },
    });
    if (member) {
      console.log(`- member '${adminEmail}': already exists`);
    } else {
      await prisma.platCtlTeamMember.create({
        data: { orgSlug: slug, email: adminEmail, name: adminName ?? "", role: "owner" },
      });
      console.log(`- member '${adminEmail}': created as owner`);
    }
  }
}

await prisma.$disconnect();
console.log("done.");
