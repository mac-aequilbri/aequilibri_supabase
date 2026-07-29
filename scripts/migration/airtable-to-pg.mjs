// Airtable → Postgres data mover (backend-switch audit Phase C).
//
//   node scripts/migration/airtable-to-pg.mjs --org <slug> [--base appXXX]
//        [--tables job,risk,...] [--execute]
//
// Dry-run by default: reads the org's Airtable base, maps every row, resolves
// links, and reports what WOULD be written — no PG writes without --execute.
//
// Idempotent: rows are matched by the airtableRecordId bridge column (Phase B),
// so re-runs update instead of duplicating. createdAt is preserved from
// Airtable's createdTime. Resumable: var/migration/<org>-air-to-pg.json tracks
// completed tables (delete it to force a full re-run; upserts make that safe).
//
// Requires: DATABASE_URL reachable, AIRTABLE_PAT, migration
// 20260728000000_phase_b_airtable_bridge applied.

import { PrismaClient } from "@prisma/client";
// §2b split: the org registry lives in the CONTROL database now.
import { PrismaClient as ControlPrismaClient } from "@prisma/control-client";
import { TABLES, EXCLUDED, REVERSE_STATUS_MAPS } from "./_map.mjs";
import { envVar, listAll, loadState, saveState, parseArgs } from "./_shared.mjs";

const USAGE = "Usage: node scripts/migration/airtable-to-pg.mjs --org <slug> [--base appXXX] [--tables a,b] [--target-url postgres://…] [--execute]";
const { org, base: baseArg, tables: only, execute } = parseArgs(USAGE);
envVar("DATABASE_URL"); // fail fast with a clear message
envVar("CONTROL_DATABASE_URL");
const controlDb = new ControlPrismaClient();

const orgRow = await controlDb.platOrganisation.findUnique({ where: { slug: org } });
// §2b: rows land in the org's OWN tenant database when one is provisioned.
// Resolution order: --target-url > the org's settings.tenantDatabaseUrl >
// the shared default (DATABASE_URL).
const targetIdx = process.argv.indexOf("--target-url");
let targetUrl = targetIdx > -1 ? process.argv[targetIdx + 1] : null;
if (!targetUrl && orgRow) {
  try {
    targetUrl = JSON.parse(orgRow.settings || "{}")?.tenantDatabaseUrl || null;
  } catch {
    /* default */
  }
}
const prisma = targetUrl ? new PrismaClient({ datasourceUrl: targetUrl }) : new PrismaClient();
console.log(`target tenant DB: ${targetUrl ?? "(default DATABASE_URL)"}`);
if (!orgRow) throw new Error(`No PlatOrganisation with slug '${org}' — create/seed the org first.`);
const baseId = baseArg ?? orgRow.airtableBaseId;
if (!baseId) throw new Error(`Org '${org}' has no airtableBaseId — pass --base appXXX.`);

const statePath = `var/migration/${org}-air-to-pg.json`;
const state = loadState(statePath);
console.log(`${execute ? "EXECUTE" : "DRY-RUN"}: ${baseId} → Postgres org '${org}' (id ${orgRow.id})`);
for (const e of EXCLUDED) console.log(`  [excluded] ${e.air}: ${e.reason}`);

// rec… id → PG pk, per table key. Seeded from PG (prior runs), grown as we insert.
const recMaps = {};
async function recMap(t) {
  if (!recMaps[t.key]) {
    const rows = await prisma[t.model].findMany({
      where: { orgId: orgRow.id, airtableRecordId: { not: null } },
      select: { id: true, airtableRecordId: true },
    });
    recMaps[t.key] = new Map(rows.map((r) => [r.airtableRecordId, r.id]));
  }
  return recMaps[t.key];
}
const byKey = Object.fromEntries(TABLES.map((t) => [t.key, t]));

function pgValue(spec, fields) {
  const v = fields[spec.air];
  if (spec.kind === "bool") {
    let b = v === true; // Airtable omits unchecked checkboxes
    if (spec.boolMap) b = String(v) === spec.boolMap.true;
    return spec.invert ? !b : b;
  }
  if (v === undefined || v === null) return undefined;
  if (spec.kind === "num") return Number(v);
  if (spec.kind === "date") return new Date(String(v));
  const s = String(v);
  return spec.statusMap ? (REVERSE_STATUS_MAPS[spec.statusMap][s] ?? s) : s;
}

const summary = [];
for (const t of TABLES) {
  if (only && !only.includes(t.key)) continue;
  if (state.doneTables.includes(t.key) && execute) {
    console.log(`- ${t.key}: checkpointed done, skipping (delete ${statePath} to redo)`);
    continue;
  }
  // Vertical templates differ (e.g. legal bases carry no VENDORS): an absent
  // table is a skip, not a failure — reconciliation reports coverage later.
  let allRecords;
  try {
    allRecords = await listAll(baseId, t.air);
  } catch (err) {
    console.log(`- ${t.key}: ${t.air} absent/unreadable on this base — skipped (${String(err.message).slice(0, 80)})`);
    summary.push({ table: t.key, airRows: "absent", created: 0, updated: 0, skipped: 0 });
    continue;
  }
  const records = allRecords.filter((r) => !t.airFilter || t.airFilter(r.fields));
  const map = await recMap(t);
  let created = 0, updated = 0, skipped = 0;
  const pendingSelf = [];

  for (const rec of records) {
    const data = {};
    for (const spec of t.fields) {
      const v = pgValue(spec, rec.fields);
      if (v !== undefined) data[spec.pg] = v;
    }
    Object.assign(data, t.pgDerive ? t.pgDerive(rec.fields, rec) : {});
    let unresolved = false;
    for (const l of t.links) {
      const v = rec.fields[l.air];
      // `text: true` links carry a bare id string (e.g. CHAT_MESSAGES.
      // Session_Id) instead of Airtable's link array — same recMap resolution.
      const airId = l.text
        ? (typeof v === "string" && v ? v : null)
        : (Array.isArray(v) && v[0] ? v[0] : null);
      if (airId) {
        const pk = (await recMap(byKey[l.target])).get(airId);
        if (pk) data[l.pg] = pk;
        else unresolved = true;
      }
    }
    for (const sl of t.selfLinks ?? []) {
      const arr = rec.fields[sl.air];
      if (Array.isArray(arr) && arr[0]) pendingSelf.push({ recId: rec.id, air: sl.air, pg: sl.pg, targetRec: arr[0] });
    }
    if (unresolved) console.log(`  ! ${t.key} ${rec.id}: unresolved link(s) left null`);

    const existing = map.get(rec.id);
    if (!execute) {
      if (existing) updated++;
      else created++;
      continue;
    }
    try {
      if (existing) {
        await prisma[t.model].update({ where: { id: existing }, data });
        updated++;
      } else {
        const row = await prisma[t.model].create({
          data: { ...data, orgId: orgRow.id, airtableRecordId: rec.id, ...(t.noCreatedAt ? {} : { createdAt: new Date(rec.createdTime) }) },
        });
        map.set(rec.id, row.id);
        created++;
      }
    } catch (err) {
      skipped++;
      console.log(`  ! ${t.key} ${rec.id} skipped: ${String(err.message).split("\n").pop()}`);
    }
  }

  // Second pass: self-links (e.g. PLAN.Predecessor) once all rows exist.
  if (execute) {
    for (const p of pendingSelf) {
      const from = map.get(p.recId), to = map.get(p.targetRec);
      if (from && to) await prisma[t.model].update({ where: { id: from }, data: { [p.pg]: to } });
    }
    state.doneTables.push(t.key);
    saveState(statePath, state);
  }
  summary.push({ table: t.key, airRows: records.length, created, updated, skipped });
  console.log(`- ${t.key}: ${records.length} Airtable rows → ${created} create, ${updated} update${skipped ? `, ${skipped} SKIPPED` : ""}`);
}

// Verification: side-by-side counts.
console.log("\nVerification (rows on each side):");
for (const s of summary) {
  const t = byKey[s.table];
  const pg = await prisma[t.model].count({ where: { orgId: orgRow.id } });
  const flag = execute && pg < s.airRows ? "  ⚠ pg < airtable" : "";
  console.log(`  ${t.air.padEnd(18)} airtable=${s.airRows}  postgres=${pg}${flag}`);
}
if (!execute) console.log("\nDry-run only. Re-run with --execute to write.");
await prisma.$disconnect();
