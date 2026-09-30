// Archive data source for the Airtable→Postgres mover.
//
// Airtable is decommissioned; the source data now lives in the per-base
// Supabase archive projects (airtable-archive-*), where each base table is a
// SQL table under the `airtable` schema with columns record_id, created_time,
// and `_raw` (the original Airtable `fields` object). This module reconstructs
// Airtable-record-shaped rows { id, createdTime, fields } from that archive so
// the existing mover + _map.mjs work unchanged.
//
// Reads over the Supabase Management API SQL endpoint (SUPABASE_ACCESS_TOKEN),
// so no direct DB connection to the archive is needed. Paged to stay well
// under the endpoint's response-size limit.

import { envVar } from "./_shared.mjs";

const PAGE = 500;

async function sql(projectRef, query) {
  const token = envVar("SUPABASE_ACCESS_TOKEN");
  for (let attempt = 1; attempt <= 5; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
    } catch (err) {
      if (attempt === 5) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (!res.ok) throw new Error(`archive SQL ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  throw new Error("archive SQL: retries exhausted");
}

// Which `airtable.*` tables exist in this archive project (some mover tables —
// quotes, vendors, bim_models… — never existed for a given client).
export async function archiveTables(projectRef) {
  const rows = await sql(
    projectRef,
    "SELECT table_name FROM information_schema.tables WHERE table_schema='airtable'",
  );
  return new Set(rows.map((r) => r.table_name));
}

/** listAll() equivalent sourced from the archive. `air` is the mover's
 *  UPPER_SNAKE Airtable table name (JOBS, CHANGE_LOG); the archive table is
 *  its lowercase form. Returns [] when the table isn't in this archive. */
export function makeArchiveListAll(projectRef, tableSet) {
  return async function archiveListAll(_baseIdIgnored, air) {
    const table = air.toLowerCase();
    if (tableSet && !tableSet.has(table)) return [];
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      // Order by record_id for a stable page window; _raw is the fields object.
      const rows = await sql(
        projectRef,
        `SELECT record_id, created_time, _raw FROM airtable.${table} ORDER BY record_id LIMIT ${PAGE} OFFSET ${offset}`,
      );
      for (const r of rows) {
        out.push({
          id: r.record_id,
          createdTime: r.created_time,
          fields: r._raw || {},
        });
      }
      if (rows.length < PAGE) break;
    }
    return out;
  };
}
