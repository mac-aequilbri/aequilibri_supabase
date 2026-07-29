// Dev helper: wipe the Plat* demo orgs (cascade deletes all platform rows)
// so prisma/seed.mjs can reseed them from scratch. Never used in production —
// and guarded so it CANNOT be: it deletes every org and every dependent row
// in whatever database DATABASE_URL points at.
import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to run: NODE_ENV=production.");
  process.exit(1);
}
// NODE_ENV alone is not enough: a workstation whose DATABASE_URL points at a
// remote database would still cascade-delete it. Require the extra flag then.
const dbUrl = process.env.DATABASE_URL ?? "";
const isLocal = /localhost|127\.0\.0\.1|^file:/.test(dbUrl);
if (dbUrl && !isLocal && !process.argv.includes("--remote-i-know-what-i-am-doing")) {
  console.error(
    "Refusing to run: DATABASE_URL is not local. If you truly mean to wipe a " +
      "remote database, re-run with --remote-i-know-what-i-am-doing as well.",
  );
  process.exit(1);
}
if (!process.argv.includes("--yes")) {
  const target = (process.env.DATABASE_URL ?? "").replace(/\/\/[^@]*@/, "//***@");
  console.error(
    `This deletes ALL platform organisations (cascade) in: ${target || "<DATABASE_URL unset>"}\n` +
      "Re-run with --yes to confirm.",
  );
  process.exit(1);
}

// §2b split: the registry is in the control DB; tenant rows no longer cascade
// from an org delete (no cross-DB FK). This dev utility removes the registry
// entries only — orphaned tenant rows in the (shared dev) tenant DB are
// harmless and get swept when the DB is recreated.
const { PrismaClient: ControlPrismaClient } = await import("@prisma/control-client");
const controlDb = new ControlPrismaClient();
await controlDb.platCtlTeamMember.deleteMany({});
await controlDb.platCtlAssignment.deleteMany({});
const r = await controlDb.platOrganisation.deleteMany({});
console.log(`Deleted ${r.count} platform organisations (registry + team + assignments; tenant rows not cascaded — §2b split).`);
await controlDb.$disconnect();
