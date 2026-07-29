// Map-vs-base drift check (migration-plan Phase 5.3). For every _map.mjs
// entry, compares the Airtable base's ACTUAL table fields (meta API,
// read-only) against the fields the map reads/writes:
//
//   MISSING  — the map expects the field but the base lacks it → migrated
//              values for that column will be empty (renames = silent loss;
//              reconcile the map or accept).
//   UNMAPPED — the base carries the field but no map entry reads it → data
//              that will NOT survive migration (accept or extend the map).
//
//   node scripts/migration/check-drift.mjs --base appXXX [--json out.json]
//
// System fields (_TIER), link fields the map resolves, and computed fields
// (formula/rollup/count/lookup — derivable, never written) are classified
// separately so the noise doesn't drown real drift.

import { writeFileSync } from "node:fs";
import { TABLES } from "./_map.mjs";
import { envVar } from "./_shared.mjs";

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const baseId = arg("base");
const jsonOut = arg("json");
if (!baseId) throw new Error("Usage: --base appXXX [--json out.json]");

const res = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
  headers: { Authorization: `Bearer ${envVar("AIRTABLE_PAT")}` },
});
if (!res.ok) throw new Error(`meta API HTTP ${res.status}: ${await res.text()}`);
const { tables } = await res.json();
const byName = new Map(tables.map((t) => [t.name, t]));

const COMPUTED = new Set(["formula", "rollup", "count", "multipleLookupValues", "autoNumber", "createdTime", "lastModifiedTime", "createdBy", "lastModifiedBy"]);
const report = { baseId, tables: [] };

// Coverage is judged per AIRTABLE TABLE (several entries can share one table,
// e.g. CHANGE_LOG ← variation_order + change_log): union every entry's read
// set, including fields consumed inside pgDerive (declared via deriveReads)
// and derived on the way back (airDerive output keys don't count — they are
// PG-sourced). Reverse link fields (an Airtable table linking BACK to this
// one) are relational echoes, not data — classified separately.
const byAirTable = new Map();
for (const t of TABLES) {
  const cur = byAirTable.get(t.air) ?? { keys: [], expected: new Set() };
  cur.keys.push(t.key);
  for (const f of t.fields) cur.expected.add(f.air);
  for (const l of t.links ?? []) cur.expected.add(l.air);
  for (const l of t.selfLinks ?? []) cur.expected.add(l.air);
  for (const n of t.deriveReads ?? []) cur.expected.add(n);
  byAirTable.set(t.air, cur);
}

for (const [airName, cov] of byAirTable) {
  const air = byName.get(airName);
  if (!air) {
    report.tables.push({ table: airName, key: cov.keys.join("+"), status: "absent" });
    continue;
  }
  const actual = new Map(air.fields.map((f) => [f.name, f.type]));
  const missing = [...cov.expected].filter((n) => !actual.has(n));
  const unmapped = [...actual.entries()]
    .filter(([n]) => !cov.expected.has(n) && n !== "_TIER")
    .map(([n, type]) => ({ name: n, type, computed: COMPUTED.has(type), link: type === "multipleRecordLinks" }));
  report.tables.push({
    table: airName,
    key: cov.keys.join("+"),
    status: "present",
    missing,
    unmappedData: unmapped.filter((u) => !u.computed && !u.link).map((u) => `${u.name} (${u.type})`),
    unmappedLinks: unmapped.filter((u) => u.link).map((u) => u.name),
    unmappedComputed: unmapped.filter((u) => u.computed).map((u) => u.name),
  });
}

// Tables on the base that no map entry touches at all.
const mapped = new Set(TABLES.map((t) => t.air));
report.unmappedTables = tables.map((t) => t.name).filter((n) => !mapped.has(n));

for (const t of report.tables) {
  if (t.status === "absent") {
    console.log(`  ~ ${t.table}: absent on base (skip)`);
    continue;
  }
  if (t.missing.length) console.log(`  ! ${t.table}: MISSING on base → empty in PG: ${t.missing.join(", ")}`);
  if (t.unmappedData.length) console.log(`  ! ${t.table}: UNMAPPED data fields (would not survive): ${t.unmappedData.join(", ")}`);
  if (t.unmappedLinks?.length) console.log(`  ~ ${t.table}: unmapped link fields (relations, review): ${t.unmappedLinks.join(", ")}`);
}
console.log(`\nTables on base with no map entry: ${report.unmappedTables.join(", ") || "(none)"}`);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`report → ${jsonOut}`);
}
