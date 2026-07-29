// Shared plumbing for the Airtable↔Postgres data movers (backend-switch
// audit Phase C). Follows the repo's ops-script conventions: plain node,
// .env fallback, ~250ms request pacing, 429/5xx retry, 10-record write
// batches, resumable state.json checkpoints.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const envCache = {};
export function envVar(name, { required = true } = {}) {
  if (process.env[name]) return process.env[name];
  if (!(name in envCache)) {
    let env = "";
    try {
      env = readFileSync(new URL("../../.env", import.meta.url), "utf8");
    } catch {
      /* no .env */
    }
    const line = env.split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    envCache[name] = line ? line.slice(name.length + 1).trim().replace(/^"|"$/g, "") : undefined;
  }
  if (envCache[name] === undefined && required) throw new Error(`${name} not set (env or .env)`);
  return envCache[name];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReq = 0;
async function paced() {
  const wait = lastReq + 250 - Date.now();
  if (wait > 0) await sleep(wait);
  lastReq = Date.now();
}

async function api(method, url, body) {
  const headers = { Authorization: `Bearer ${envVar("AIRTABLE_PAT")}` };
  if (body) headers["Content-Type"] = "application/json";
  for (let attempt = 1; attempt <= 5; attempt++) {
    await paced();
    let res;
    try {
      res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (err) {
      // Network-level failure (connect/headers timeout, reset) — retry like a
      // 5xx; flaky links must not kill an hours-long checkpointed run.
      if (attempt === 5) throw err;
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(1000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status}: ${await res.text()}`);
    return res.json();
  }
  throw new Error(`${method} ${url}: retries exhausted`);
}

/** Every record of a table (all fields + createdTime), following pagination. */
export async function listAll(baseId, table) {
  const out = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const page = await api("GET", url.toString());
    out.push(...page.records);
    offset = page.offset;
  } while (offset);
  return out;
}

/** Create records 10 per request (typecast auto-creates select options).
 *  Returns created records in input order. */
export async function createAll(baseId, table, fieldsList) {
  const created = [];
  for (let i = 0; i < fieldsList.length; i += 10) {
    const chunk = fieldsList.slice(i, i + 10).map((fields) => ({ fields }));
    const res = await api("POST", `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`, {
      records: chunk,
      typecast: true,
    });
    created.push(...res.records);
  }
  return created;
}

/** Batched partial updates: [{id, fields}] */
export async function updateAll(baseId, table, updates) {
  for (let i = 0; i < updates.length; i += 10) {
    await api("PATCH", `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`, {
      records: updates.slice(i, i + 10),
      typecast: true,
    });
  }
}

// ── checkpoint state (resume after crash/rate-limit death) ──────────────────
export function loadState(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { doneTables: [] };
}
export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

// ── CLI ──────────────────────────────────────────────────────────────────────
export function parseArgs(usage) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const parsed = {
    org: get("--org"),
    base: get("--base"),
    tables: get("--tables")?.split(","),
    execute: args.includes("--execute"),
  };
  if (!parsed.org) {
    console.error(usage);
    process.exit(1);
  }
  return parsed;
}
