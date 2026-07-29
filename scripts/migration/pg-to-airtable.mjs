// Postgres → Airtable data mover (backend-switch audit Phase C).
//
//   node scripts/migration/pg-to-airtable.mjs --org <slug> --base appXXX
//        [--tables job,risk,...] [--execute]
//
// Dry-run by default. The target base must already be provisioned with the
// platform schema (scripts/airtable-provision-base.mjs — this script moves
// DATA only, never schema). Rows whose airtableRecordId is already set are
// treated as synced and skipped, which makes re-runs idempotent; the rec id of
// every created record is written back to the PG row, so the bridge column is
// populated as a side effect. Computed Airtable fields (formulas/rollups) are
// never written; Airtable-only derives (Decision_Name, Change_Type, …) are
// recomputed from the PG row.
//
// Requires: DATABASE_URL reachable, AIRTABLE_PAT, Phase B migration applied.

import { PrismaClient } from "@prisma/client";
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";
import { TABLES, EXCLUDED, STATUS_MAPS } from "./_map.mjs";
import { envVar, createAll, updateAll, loadState, saveState, parseArgs } from "./_shared.mjs";

const USAGE = "Usage: node scripts/migration/pg-to-airtable.mjs --org <slug> --base appXXX [--tables a,b] [--execute]";
const { org, base: baseId, tables: only, execute } = parseArgs(USAGE);
if (!baseId) { console.error(USAGE); process.exit(1); }
envVar("DATABASE_URL");
const prisma = new PrismaClient();

const controlDb = new ControlPrismaClient();
const orgRow = await controlDb.platOrganisation.findUnique({ where: { slug: org } });
if (!orgRow) throw new Error(`No PlatOrganisation with slug '${org}'.`);

const statePath = `var/migration/${org}-pg-to-air.json`;
const state = loadState(statePath);
console.log(`${execute ? "EXECUTE" : "DRY-RUN"}: Postgres org '${org}' (id ${orgRow.id}) → ${baseId}`);
for (const e of EXCLUDED) console.log(`  [excluded] ${e.air}: ${e.reason}`);

// PG pk → rec… id, per table key (bridge column, includes rows synced this run).
const pkMaps = {};
async function pkMap(t) {
  if (!pkMaps[t.key]) {
    const rows = await prisma[t.model].findMany({
      where: { orgId: orgRow.id, airtableRecordId: { not: null } },
      select: { id: true, airtableRecordId: true },
    });
    pkMaps[t.key] = new Map(rows.map((r) => [r.id, r.airtableRecordId]));
  }
  return pkMaps[t.key];
}
const byKey = Object.fromEntries(TABLES.map((t) => [t.key, t]));

function airValue(spec, row) {
  const v = row[spec.pg];
  if (spec.kind === "bool") {
    let b = spec.invert ? !v : !!v;
    return spec.boolMap ? spec.boolMap[String(b)] : b;
  }
  if (v === undefined || v === null) return undefined;
  if (spec.kind === "num") return Number(String(v)); // handles Prisma Decimal
  if (spec.kind === "date") return v.toISOString ? v.toISOString() : String(v);
  const s = String(v);
  if (s === "") return undefined;
  return spec.statusMap ? (STATUS_MAPS[spec.statusMap][s] ?? s) : s;
}

const summary = [];
for (const t of TABLES) {
  if (only && !only.includes(t.key)) continue;
  if (state.doneTables.includes(t.key) && execute) {
    console.log(`- ${t.key}: checkpointed done, skipping`);
    continue;
  }
  const rows = await prisma[t.model].findMany({ where: { orgId: orgRow.id }, orderBy: { id: "asc" } });
  const map = await pkMap(t);
  const toCreate = [];
  let alreadySynced = 0, unresolvedLinks = 0;

  for (const row of rows) {
    if (row.airtableRecordId) { alreadySynced++; continue; }
    const fields = {};
    for (const spec of t.fields) {
      const cell = airValue(spec, row);
      if (cell !== undefined) fields[spec.air] = cell;
    }
    Object.assign(fields, t.airDerive ? t.airDerive(row) : {});
    for (const l of t.links) {
      const pk = row[l.pg];
      if (pk == null) continue;
      const rec = (await pkMap(byKey[l.target])).get(pk);
      if (rec) fields[l.air] = [rec];
      else unresolvedLinks++;
    }
    toCreate.push({ row, fields });
  }

  if (execute && toCreate.length) {
    const createdRecs = await createAll(baseId, t.air, toCreate.map((x) => x.fields));
    for (let i = 0; i < createdRecs.length; i++) {
      const { row } = toCreate[i];
      await prisma[t.model].update({ where: { id: row.id }, data: { airtableRecordId: createdRecs[i].id } });
      map.set(row.id, createdRecs[i].id);
    }
  }

  // Second pass: self-links (PLAN.Predecessor) once every row has a rec id.
  if (execute && (t.selfLinks ?? []).length) {
    const updates = [];
    for (const row of rows) {
      for (const sl of t.selfLinks) {
        const targetRec = row[sl.pg] != null ? map.get(row[sl.pg]) : undefined;
        const selfRec = map.get(row.id);
        if (targetRec && selfRec) updates.push({ id: selfRec, fields: { [sl.air]: [targetRec] } });
      }
    }
    if (updates.length) await updateAll(baseId, t.air, updates);
  }

  if (execute) { state.doneTables.push(t.key); saveState(statePath, state); }
  summary.push({ t, pgRows: rows.length, created: toCreate.length, alreadySynced });
  console.log(
    `- ${t.key}: ${rows.length} PG rows → ${toCreate.length} create, ${alreadySynced} already synced` +
    (unresolvedLinks ? `, ${unresolvedLinks} unresolved links omitted` : ""),
  );
  if (!execute && toCreate[0]) console.log(`    sample: ${JSON.stringify(toCreate[0].fields).slice(0, 200)}`);
}

console.log(`\n${execute ? "Done." : "Dry-run only. Re-run with --execute to write."} ` +
  `Verify with the org's /diagnostics page (side-by-side counts).`);
await prisma.$disconnect();
