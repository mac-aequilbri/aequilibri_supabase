// Synthetic test data for Aamayah Stella Builders (org 1, shared default
// tenant DB) — exercises every feature enabled in the org's settings: jobs,
// phases, budgets, cashflow ledger, risks, variations, quotes, documents,
// meeting minutes, weekly reports, comms, chat + approvals, learning loop,
// BIM, portal tokens, assessments, change log.
//
//   node scripts/seed-aamayah-stella.mjs [--dry-run]
//
// Writes via the Supabase Management API SQL endpoint (no DB password needed;
// SUPABASE_ACCESS_TOKEN from .env.ops). Deterministic (fixed SEED). Guarded:
// aborts if the org already has jobs, so it can never duplicate itself.

import { readFileSync } from "node:fs";

const ORG_ID = 1;
const SEED = 20260814;
const TODAY = new Date("2026-08-14T00:00:00Z");
const CONTROL_REF = "xpiqrxveestyeaxsebdu"; // aequilibri-control
const TENANT_REF = "ftodudqphxtyncxjhkhk"; // aequilibri-t-default
const DRY = process.argv.includes("--dry-run");

// ── env + SQL transport ───────────────────────────────────────────────────────
const env = {};
for (const f of [".env", ".env.ops"]) {
  try {
    for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, "");
    }
  } catch {}
}
if (!env.SUPABASE_ACCESS_TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN missing (.env.ops)");

let reqCount = 0;
async function runSql(ref, query) {
  reqCount++;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 5) throw new Error(`SQL ${ref} → ${res.status} after retries`);
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`SQL on ${ref} → ${res.status}: ${text.slice(0, 800)}\n-- query head: ${query.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  }
}

// ── SQL literal helpers ───────────────────────────────────────────────────────
const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return `'${v.toISOString()}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const totalsByTable = {};
async function insert(table, cols, rows, { returning = null, chunk = 300 } = {}) {
  const out = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const values = slice.map((r) => `(${cols.map((c) => q(r[c])).join(",")})`).join(",\n");
    const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES\n${values}${returning ? ` RETURNING ${returning}` : ""}`;
    if (DRY) { out.push(...slice.map(() => ({}))); continue; }
    const res = await runSql(TENANT_REF, sql);
    if (returning) out.push(...res);
    await new Promise((r) => setTimeout(r, 250)); // stay well under the API rate limit
  }
  totalsByTable[table] = (totalsByTable[table] ?? 0) + rows.length;
  console.log(`  ✓ ${table}: ${rows.length}`);
  return out;
}

// ── deterministic PRNG (mulberry32, same as scripts/legal-demo/_lib.mjs) ─────
function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    picks: (arr, n) => { const c = [...arr]; const o = []; for (let i = 0; i < n && c.length; i++) o.push(c.splice(Math.floor(next() * c.length), 1)[0]); return o; },
    bool: (p = 0.5) => next() < p,
    weighted: (pairs) => { const t = pairs.reduce((s, [, w]) => s + w, 0); let r = next() * t; for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; } return pairs.at(-1)[0]; },
  };
}
const addDays = (d, n) => { const c = new Date(d.getTime()); c.setUTCDate(c.getUTCDate() + n); return c; };
const isoDate = (d) => d.toISOString().slice(0, 10);
const monthKey = (d) => d.toISOString().slice(0, 7);
const money = (r, lo, hi, step = 50) => Math.round((lo + r.next() * (hi - lo)) / step) * step;
const J = (v) => JSON.stringify(v);

// ── vocabulary ────────────────────────────────────────────────────────────────
const SUBURBS = ["Maroochydore", "Buderim", "Caloundra", "Noosa Heads", "Nambour", "Coolum Beach", "Mooloolaba", "Peregian Springs", "Palmwoods", "Beerwah", "Sippy Downs", "Twin Waters", "Golden Beach", "Mountain Creek", "Woombye", "Yandina", "Eumundi", "Bli Bli", "Warana", "Kawana Waters"];
const STREETS = ["Ocean Parade", "Banksia Street", "Coral Avenue", "Hilltop Crescent", "Jacaranda Drive", "Melaleuca Court", "Pandanus Way", "Sunrise Terrace", "Wattle Lane", "Headland Road", "Riverbend Drive", "Casuarina Close", "Palm Grove", "Seaview Street", "Karawatha Drive"];
const FIRST = ["Liam", "Olivia", "Noah", "Amelia", "Jack", "Charlotte", "Henry", "Mia", "Oscar", "Isla", "Leo", "Grace", "Hunter", "Ruby", "Ethan", "Zoe", "Mason", "Sofia", "Archie", "Evie", "Tom", "Priya", "Marco", "Aisha", "Declan", "Mei", "Kai", "Freya", "Sam", "Talia"];
const LAST = ["Nguyen", "Smith", "Patel", "Williams", "Chen", "Taylor", "Kaur", "Brown", "Silva", "Jones", "Ivanov", "Wilson", "Rossi", "Martin", "Okafor", "Thompson", "Yamada", "Clark", "Haddad", "Walker", "Mercer", "OBrien", "Fitzgerald", "Duarte", "Lindqvist"];
const COMPANY_SUFFIX = ["Pty Ltd", "Holdings", "Group", "Developments", "Investments"];
const COMPANY_STEM = ["Coastline", "Hinterland", "Bluewater", "Sunstate", "Pacific Crest", "Greenridge", "Northpoint", "Seabreeze", "Stonegate", "Brightwater"];

const LONG_TYPES = [
  { label: "New Home Build", budget: [480000, 1400000], durDays: [240, 420], phases: ["Site Preparation", "Foundation & Slab", "Framing", "Roofing & Lockup", "Services Rough-in", "Internal Linings", "Fitout & Finishes", "Practical Completion"] },
  { label: "Knockdown Rebuild", budget: [550000, 1600000], durDays: [270, 450], phases: ["Demolition", "Site Preparation", "Foundation & Slab", "Framing", "Roofing & Lockup", "Services Rough-in", "Fitout & Finishes", "Practical Completion"] },
  { label: "Major Renovation", budget: [220000, 700000], durDays: [150, 300], phases: ["Design & Approvals", "Strip-out", "Structural Works", "Services Rough-in", "Internal Linings", "Fitout & Finishes", "Handover"] },
  { label: "Duplex Development", budget: [900000, 1800000], durDays: [300, 480], phases: ["Site Preparation", "Foundation & Slab", "Framing", "Roofing & Lockup", "Services Rough-in", "Internal Linings", "Fitout & Finishes", "Practical Completion"] },
  { label: "House Extension", budget: [180000, 520000], durDays: [120, 240], phases: ["Design & Approvals", "Site Preparation", "Foundation & Slab", "Framing & Roofing", "Services Rough-in", "Fitout & Finishes", "Handover"] },
];
const SHORT_TYPES = [
  { label: "Kitchen Renovation", budget: [38000, 95000], durDays: [25, 60], phases: ["Design & Selections", "Strip-out", "Trade Works", "Joinery Install", "Finishes & Handover"] },
  { label: "Bathroom Renovation", budget: [28000, 65000], durDays: [20, 45], phases: ["Design & Selections", "Strip-out", "Waterproofing & Tiling", "Fitoff", "Handover"] },
  { label: "Deck & Pergola", budget: [18000, 55000], durDays: [15, 40], phases: ["Approvals", "Footings & Subframe", "Decking & Roof", "Finishes & Handover"] },
  { label: "Garage Conversion", budget: [32000, 80000], durDays: [25, 55], phases: ["Design & Approvals", "Strip-out", "Trade Works", "Finishes & Handover"] },
  { label: "Retaining Wall & Landscaping", budget: [15000, 48000], durDays: [12, 35], phases: ["Site Survey", "Earthworks", "Wall Construction", "Drainage & Finishes"] },
  { label: "Laundry & Mudroom Reno", budget: [16000, 38000], durDays: [12, 30], phases: ["Design & Selections", "Strip-out", "Trade Works", "Finishes & Handover"] },
];
const BUDGET_CATS = ["Preliminaries", "Site Works", "Foundation", "Framing", "Roofing", "External Cladding", "Windows & Doors", "Plumbing", "Electrical", "Plastering", "Joinery & Fitout", "Painting", "Landscaping", "Contingency"];
const VENDORS = [
  ["Sunshine Frame & Truss", "Framing"], ["Reef Roofing Supplies", "Roofing"], ["Range Plumbing Co", "Plumbing"],
  ["Coastal Glazing", "Windows & Doors"], ["Hinterland Concrete", "Concrete"], ["Sparky Coast Electrical", "Electrical"],
  ["Buderim Joinery Works", "Joinery"], ["ProPlaster Sunshine Coast", "Plastering"], ["Noosa Painting Group", "Painting"],
  ["Earthline Excavations", "Earthworks"], ["Maroochy Tiling Co", "Tiling"], ["Bli Bli Landscapes", "Landscaping"],
  ["Kawana Scaffolding", "Scaffolding"], ["Coastwide Waterproofing", "Waterproofing"], ["Palmwoods Timber & Hardware", "Materials"],
  ["Sunstate Steel Supplies", "Steel"], ["AirFlow Climate Solutions", "HVAC"], ["SecureIt Garage Doors", "Garage Doors"],
  ["EcoInsulate QLD", "Insulation"], ["BrightPave Driveways", "Concreting"], ["Coral Sea Cabinetry", "Joinery"],
  ["TruLevel Carpentry Crew", "Carpentry"], ["Rapid Skips & Waste", "Waste"], ["GreenSwitch Solar", "Solar"],
];
const RISK_POOL = [
  "Wet season rainfall delaying slab pour and external works",
  "Timber frame package lead time slipping beyond program",
  "Trade shortage — carpenters double-booked in peak period",
  "Council inspection backlog delaying frame sign-off",
  "Client selections late — joinery order window at risk",
  "Rock encountered in excavation — footing redesign possible",
  "Window package import delay (8–10 week lead time)",
  "Material price escalation on steel and timber",
  "Neighbour dispute over boundary access for scaffolding",
  "Asbestos found in strip-out — licensed removal required",
  "Retaining wall engineering revision after geotech report",
  "Subcontractor insurance lapsed — rework of trade schedule",
  "Driveway crossover approval pending with council",
  "Wet area waterproofing certification delay",
  "Power connection delay from network operator",
];
const ACTION_POOL = [
  "Book frame inspection with certifier", "Chase plumber quote for rough-in", "Confirm window delivery window with supplier",
  "Order joinery package — selections locked", "Schedule waterproofing certifier", "Submit progress claim to client",
  "Review geotech report against footing design", "Lock in scaffold erection date", "Confirm colour selections with client",
  "Arrange temporary fencing renewal", "Book final electrical fitoff", "Prepare handover pack and warranties",
  "Follow up council on driveway crossover", "Reconcile vendor invoices against budget", "Update cashflow forecast for next quarter",
  "Site clean and waste removal before inspection", "Order tapware and fixtures", "Confirm termite barrier installation",
];
const DECISION_POOL = [
  ["Switch roof profile from tiles to Colorbond", "Cyclone rating and 2-week shorter lead time", "Materials"],
  ["Upgrade to 2.7m ceilings on ground floor", "Client request; framing quote variance acceptable", "Scope"],
  ["Defer pool excavation until after handover", "Avoids double-handling crane access", "Sequencing"],
  ["Use in-situ concrete stairs instead of precast", "Precast supplier at capacity", "Materials"],
  ["Engage second carpentry crew for lockup", "Recover 8 days of program slip", "Resourcing"],
  ["Substitute imported tiles with local stock", "12-week import delay vs 2-week local", "Materials"],
  ["Bring electrical rough-in forward one week", "Plasterer availability window", "Sequencing"],
  ["Fixed-price the landscaping package", "Client cashflow certainty preferred", "Commercial"],
  ["Adopt weekly client update reports", "Reduce ad-hoc calls and email churn", "Process"],
  ["Require PO before any vendor order over $2k", "Budget control after August overrun", "Process"],
];
const DOC_TYPES = [
  ["Building contract (HIA)", "contract", "contract"], ["Approved architectural drawings", "drawing", ""],
  ["Engineering — slab design", "drawing", ""], ["Soil test / geotech report", "report", ""],
  ["Development approval", "permit", ""], ["Form 15 design certificate", "permit", ""],
  ["Insurance certificate of currency", "certificate", ""], ["Progress claim", "invoice", ""],
  ["Site photos — progress", "photo", ""], ["Selections schedule", "report", ""],
  ["Waterproofing certificate", "certificate", ""], ["Termite barrier certificate", "certificate", ""],
  ["Variation quotation", "quote", ""], ["Practical completion checklist", "report", ""],
];
const COMMS_POOL = [
  ["Progress update to client", "Status Update", "Owner"],
  ["Progress claim issued — payment due", "Action Required", "Owner"],
  ["Selections required to hold joinery slot", "Action Required", "Owner"],
  ["Variation approval required", "Approval Request", "Owner"],
  ["Inspection booked — access required", "Status Update", "Regulatory"],
  ["Certifier documentation request", "Action Required", "Regulatory"],
];
const QUOTE_ITEMS = [
  ["Preliminaries & site setup", "Preliminaries", "item", [2500, 9000]],
  ["Demolition / strip-out", "Site Works", "item", [3000, 14000]],
  ["Concrete slab / footings", "Foundation", "m²", [8000, 45000]],
  ["Timber framing package", "Framing", "item", [12000, 90000]],
  ["Roofing — Colorbond", "Roofing", "m²", [9000, 48000]],
  ["Windows & external doors", "Windows & Doors", "item", [8000, 60000]],
  ["Plumbing rough-in & fitoff", "Plumbing", "item", [6000, 38000]],
  ["Electrical rough-in & fitoff", "Electrical", "item", [5000, 32000]],
  ["Plasterboard & cornice", "Plastering", "m²", [4000, 26000]],
  ["Joinery & cabinetry", "Joinery & Fitout", "item", [9000, 70000]],
  ["Internal & external painting", "Painting", "m²", [4000, 24000]],
  ["Landscaping & driveway", "Landscaping", "item", [5000, 35000]],
];
const TEAM = [
  ["Mac Antonio", "admin", "mac@aequilibri.com"],
  ["Stella Nguyen", "editor", "stella@aamayahstella.example"],
  ["Aamayah Cole", "editor", "aamayah@aamayahstella.example"],
  ["Ravi Patel", "editor", "ravi@aamayahstella.example"],
  ["Grace Muller", "editor", "grace@aamayahstella.example"],
  ["Site Crew Shared", "readonly", "site@aamayahstella.example"],
];
const OWNERS = ["Mac Antonio", "Stella Nguyen", "Ravi Patel", "Aamayah Cole"];
const AI_NAME = "Aayah";

const personName = (r) => `${r.pick(FIRST)} ${r.pick(LAST)}`;
const companyName = (r) => `${r.pick(COMPANY_STEM)} ${r.pick(COMPANY_SUFFIX)}`;

// ── generation ────────────────────────────────────────────────────────────────
function buildContacts() {
  const r = rng(SEED ^ 0x11);
  const out = [];
  for (let i = 0; i < 70; i++) {
    const isCompany = r.bool(0.22);
    const name = isCompany ? companyName(r) : personName(r);
    const suburb = r.pick(SUBURBS);
    out.push({
      org_id: ORG_ID, name,
      contact_type: isCompany ? "developer" : "client",
      role: isCompany ? "Commercial client" : "Homeowner",
      email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}@${isCompany ? "example.com.au" : "gmail.com"}`,
      phone: `04${r.int(10, 99)} ${r.int(100, 999)} ${r.int(100, 999)}`,
      company: isCompany ? name : "",
      notes: `${isCompany ? "Corporate" : "Residential"} client — ${suburb} QLD`,
      is_active: true, suburb,
    });
  }
  return out;
}

function buildJobs(contactIds, contacts) {
  const r = rng(SEED ^ 0x22);
  const START = addDays(TODAY, -540); // 18 months of history
  const yearSeq = {};
  const jobs = [];
  for (let i = 0; i < 95; i++) {
    const isLong = r.bool(0.42);
    const cat = r.pick(isLong ? LONG_TYPES : SHORT_TYPES);
    const dayOffset = Math.floor(Math.pow(r.next(), 0.85) * 539);
    const start = addDays(START, dayOffset);
    const ageDays = Math.round((TODAY - start) / 86400000);
    const durDays = r.int(cat.durDays[0], cat.durDays[1]);
    const target = addDays(start, durDays);
    const closeProb = Math.min(0.95, ageDays / (durDays + 30));
    const isComplete = r.next() < closeProb && ageDays > durDays * 0.7;
    let status, completionPct, healthScore;
    if (isComplete) { status = "complete"; completionPct = 100; healthScore = r.int(72, 96); }
    else if (ageDays < 10 && r.bool(0.5)) { status = "intake"; completionPct = 0; healthScore = r.int(55, 75); }
    else if (r.bool(0.06)) { status = "on_hold"; completionPct = r.int(10, 60); healthScore = r.int(35, 60); }
    else { status = "active"; completionPct = Math.min(95, Math.max(5, Math.round((ageDays / durDays) * 100) + r.int(-10, 10))); healthScore = r.weighted([[r.int(75, 92), 6], [r.int(55, 74), 3], [r.int(38, 54), 1]]); }
    const ci = r.int(0, contactIds.length - 1);
    const year = start.getUTCFullYear();
    yearSeq[year] = (yearSeq[year] ?? 0) + 1;
    const code = `ASB-${year}-${String(yearSeq[year]).padStart(3, "0")}`;
    const suburb = contacts[ci].suburb;
    const budget = money(r, cat.budget[0], cat.budget[1], 500);
    const clientLabel = contacts[ci].name.split(" ").slice(-1)[0];
    jobs.push({
      i, code, cat, isLong, start, target, durDays, ageDays, isComplete, status,
      row: {
        org_id: ORG_ID, code, name: `${cat.label} — ${contacts[ci].name.replace(/ (Pty Ltd|Holdings|Group|Developments|Investments)$/, "")}, ${suburb}`,
        engagement_type: isLong ? "long_project" : "short_job", status,
        client_contact_id: contactIds[ci],
        address: `${r.int(1, 180)} ${r.pick(STREETS)}`, suburb,
        lat: -26.65 + r.next() * 0.35, lng: 152.85 + r.next() * 0.3,
        start_date: isoDate(start), target_end_date: isoDate(target),
        completion_pct: completionPct, health_score: healthScore, budget_total: budget,
        summary: `${cat.label} for the ${clientLabel} ${contacts[ci].company ? "portfolio" : "family"} in ${suburb}. ${isLong ? "Full project delivery with staged progress claims." : "Fixed-price short engagement."}`,
        created_at: start.toISOString(), updated_at: (isComplete ? target : TODAY).toISOString(),
      },
    });
  }
  return jobs;
}

async function main() {
  console.log(`Seeding Aamayah Stella Builders (org ${ORG_ID}) into aequilibri-t-default${DRY ? " [DRY RUN]" : ""}…`);
  const guard = await runSql(TENANT_REF, `SELECT count(*)::int AS n FROM plat_core_job WHERE org_id = ${ORG_ID}`);
  if (guard[0].n > 0) throw new Error(`Org ${ORG_ID} already has ${guard[0].n} jobs — refusing to double-seed.`);

  // ── config tier ────────────────────────────────────────────────────────────
  await insert("plat_cfg_teammember", ["org_id", "name", "role", "email", "is_active"],
    TEAM.map(([name, role, email]) => ({ org_id: ORG_ID, name, role, email, is_active: true })));
  await insert("plat_cfg_reference", ["org_id", "ref_type", "code", "name", "sort_order", "is_active"],
    BUDGET_CATS.map((c, i) => ({ org_id: ORG_ID, ref_type: "budget_category", code: c.toLowerCase().replace(/[^a-z0-9]+/g, "_"), name: c, sort_order: i, is_active: true })));
  await insert("plat_core_engagementtypeconfig",
    ["org_id", "config_name", "engagement_type", "active", "plan_view", "full_risk_register", "cashflow_period", "portfolio_view", "tier"],
    [
      { org_id: ORG_ID, config_name: "Long project delivery", engagement_type: "long_project", active: true, plan_view: "gantt", full_risk_register: true, cashflow_period: "monthly", portfolio_view: true, tier: "core" },
      { org_id: ORG_ID, config_name: "Short fixed-price job", engagement_type: "short_job", active: true, plan_view: "checklist", full_risk_register: false, cashflow_period: "monthly", portfolio_view: true, tier: "core" },
    ]);

  // ── contacts + vendors ─────────────────────────────────────────────────────
  const contacts = buildContacts();
  const contactRows = await insert("plat_core_contact",
    ["org_id", "name", "contact_type", "role", "email", "phone", "company", "notes", "is_active"],
    contacts, { returning: "id" });
  const contactIds = contactRows.map((x) => x.id);

  const rv = rng(SEED ^ 0x33);
  const vendorRows = await insert("plat_con_vendor",
    ["org_id", "name", "category", "contact_name", "contact_email", "contact_phone", "rating", "is_active"],
    VENDORS.map(([name, category]) => ({
      org_id: ORG_ID, name, category, contact_name: personName(rv),
      contact_email: `accounts@${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.example`,
      contact_phone: `07 5${rv.int(100, 999)} ${rv.int(1000, 9999)}`, rating: rv.int(5, 10), is_active: true,
    })), { returning: "id, name" });

  // ── jobs (plus the org-level General bucket) ───────────────────────────────
  const jobs = buildJobs(contactIds, contacts);
  const generalRow = await insert("plat_core_job",
    ["org_id", "code", "name", "engagement_type", "status", "completion_pct", "health_score", "budget_total", "summary", "created_at", "updated_at"],
    [{ org_id: ORG_ID, code: "ASB-GEN", name: "General", engagement_type: "general", status: "active", completion_pct: 0, health_score: 75, budget_total: 0, summary: "Org-level bucket for records not tied to a single project.", created_at: addDays(TODAY, -540).toISOString(), updated_at: TODAY.toISOString() }],
    { returning: "id" });
  const generalJobId = generalRow[0]?.id;
  const jobCols = Object.keys(jobs[0].row);
  const jobRows = await insert("plat_core_job", jobCols, jobs.map((j) => j.row), { returning: "id, code" });
  const idByCode = Object.fromEntries(jobRows.map((x) => [x.code, x.id]));
  jobs.forEach((j) => { j.id = idByCode[j.code]; });

  // ── phases ─────────────────────────────────────────────────────────────────
  const phaseRows = [];
  for (const j of jobs) {
    const r = rng(SEED ^ 0x44 ^ (j.i * 2654435761));
    const names = j.cat.phases;
    const progress = j.isComplete ? 1 : j.status === "intake" ? 0 : Math.min(0.95, Math.max(0.05, j.ageDays / j.durDays));
    const currentIdx = j.isComplete ? names.length : Math.min(names.length - 1, Math.floor(progress * names.length));
    const per = Math.max(5, Math.round(j.durDays / names.length));
    names.forEach((name, idx) => {
      let status, pct, rag;
      if (idx < currentIdx) { status = "complete"; pct = 100; rag = "Green"; }
      else if (idx === currentIdx && !j.isComplete && j.status !== "intake") { status = "in_progress"; pct = r.int(15, 85); rag = r.weighted([["Green", 5], ["Amber", 3], ["Red", 1]]); }
      else { status = "pending"; pct = 0; rag = ""; }
      const start = addDays(j.start, idx * per);
      phaseRows.push({
        job: j, idx,
        row: {
          org_id: ORG_ID, job_id: j.id, name, status, completion_pct: pct, sort_order: idx + 1,
          start_date: isoDate(start), end_date: idx < currentIdx ? isoDate(addDays(start, per)) : null,
          is_ai_draft: false, rag, created_at: j.start.toISOString(),
        },
      });
    });
    // one AI-drafted phase suggestion on a couple of active long projects
    if (j.isLong && j.status === "active" && r.bool(0.08)) {
      phaseRows.push({ job: j, idx: names.length, row: { org_id: ORG_ID, job_id: j.id, name: "Defects & Warranty Period (AI suggested)", status: "pending", completion_pct: 0, sort_order: names.length + 1, start_date: null, end_date: null, is_ai_draft: true, rag: "", created_at: TODAY.toISOString() } });
    }
  }
  const phaseIdsRes = await insert("plat_con_phase",
    ["org_id", "job_id", "name", "status", "completion_pct", "sort_order", "start_date", "end_date", "is_ai_draft", "rag", "created_at"],
    phaseRows.map((p) => p.row), { returning: "id" });
  phaseRows.forEach((p, k) => { p.id = phaseIdsRes[k]?.id; });
  const phasesByJob = {};
  for (const p of phaseRows) (phasesByJob[p.job.id] ??= []).push(p);

  // ── budget lines ───────────────────────────────────────────────────────────
  const budgetRows = [];
  for (const j of jobs) {
    const r = rng(SEED ^ 0x55 ^ (j.i * 40503));
    const nCats = j.isLong ? r.int(6, 9) : r.int(3, 5);
    const cats = r.picks(BUDGET_CATS, nCats);
    const weights = cats.map(() => 0.5 + r.next());
    const wSum = weights.reduce((a, b) => a + b, 0);
    const jobPhases = phasesByJob[j.id] ?? [];
    cats.forEach((cat, k) => {
      const budget = Math.round((j.row.budget_total * weights[k]) / wSum / 50) * 50;
      const spendFrac = j.isComplete ? 0.9 + r.next() * 0.25 : (j.row.completion_pct / 100) * (0.8 + r.next() * 0.4);
      const actual = Math.round((budget * Math.min(spendFrac, 1.3)) / 10) * 10;
      const committed = Math.min(budget * 1.2, Math.round((actual + budget * (j.isComplete ? 0 : r.next() * 0.3)) / 10) * 10);
      const phase = jobPhases.length && r.bool(0.7) ? jobPhases[Math.min(k, jobPhases.length - 1)] : null;
      budgetRows.push({
        org_id: ORG_ID, job_id: j.id, phase_id: phase?.id ?? null, category: cat,
        description: `${cat} — ${j.cat.label.toLowerCase()}`,
        budget_amount: budget, committed_amount: committed, actual_amount: actual,
        created_at: j.start.toISOString(), updated_at: (j.isComplete ? j.target : TODAY).toISOString(),
      });
    });
  }
  await insert("plat_con_budgetline",
    ["org_id", "job_id", "phase_id", "category", "description", "budget_amount", "committed_amount", "actual_amount", "created_at", "updated_at"],
    budgetRows);

  // ── cashflow ledger (per-transaction, the wired system of record) ──────────
  const ledgerRows = [];
  for (const j of jobs) {
    const r = rng(SEED ^ 0x66 ^ (j.i * 374761393));
    if (j.status === "intake") continue;
    const nClaims = j.isLong ? r.int(4, 7) : r.int(1, 3);
    const billFrac = j.isComplete ? 1 : j.row.completion_pct / 100;
    for (let k = 0; k < nClaims; k++) {
      const d = addDays(j.start, Math.round((j.durDays / nClaims) * (k + 0.7)));
      if (d > TODAY && !j.isComplete) continue;
      const when = d > TODAY ? TODAY : d;
      const amt = Math.round((j.row.budget_total * billFrac) / nClaims / 10) * 10;
      const paid = j.isComplete || when < addDays(TODAY, -30);
      ledgerRows.push({
        org_id: ORG_ID, job_id: j.id, name: `${j.code} · Progress claim ${k + 1}`, period: monthKey(when),
        type: "In", amount: amt, source_or_payee: contacts[0] ? j.row.name.split("— ")[1] ?? "Client" : "Client",
        category: "Progress claim", status: paid ? "Paid" : "Confirmed",
        notes: `Progress claim ${k + 1} of ${nClaims}.`, created_at: when.toISOString(), updated_at: when.toISOString(),
      });
    }
    const nOut = j.isLong ? r.int(6, 10) : r.int(2, 5);
    for (let k = 0; k < nOut; k++) {
      const d = addDays(j.start, r.int(3, Math.max(4, Math.min(j.ageDays, j.durDays))));
      const v = r.pick(vendorRows);
      const amt = money(r, j.row.budget_total * 0.01, j.row.budget_total * 0.12, 10);
      ledgerRows.push({
        org_id: ORG_ID, job_id: j.id, name: `${j.code} · ${v.name} invoice`, period: monthKey(d),
        type: "Out", amount: amt, source_or_payee: v.name,
        category: r.pick(BUDGET_CATS), status: d < addDays(TODAY, -21) ? "Paid" : r.weighted([["Confirmed", 3], ["Forecast", 1]]),
        notes: "Vendor invoice.", created_at: d.toISOString(), updated_at: d.toISOString(),
      });
    }
    // forecast rows for active jobs
    if (!j.isComplete && j.status === "active") {
      for (let m = 1; m <= 2; m++) {
        const d = addDays(TODAY, 30 * m);
        if (d > j.target) break;
        ledgerRows.push({
          org_id: ORG_ID, job_id: j.id, name: `${j.code} · Forecast claim`, period: monthKey(d),
          type: "In", amount: Math.round(j.row.budget_total * 0.12 / 10) * 10, source_or_payee: "Client",
          category: "Progress claim", status: "Forecast", notes: "Forecast billing.",
          created_at: TODAY.toISOString(), updated_at: TODAY.toISOString(),
        });
      }
    }
  }
  await insert("plat_con_cashflowledger",
    ["org_id", "job_id", "name", "period", "type", "amount", "source_or_payee", "category", "status", "notes", "created_at", "updated_at"],
    ledgerRows);

  // ── risks ──────────────────────────────────────────────────────────────────
  const riskRows = [];
  for (const j of jobs) {
    const r = rng(SEED ^ 0x77 ^ (j.i * 668265263));
    if (j.status === "intake") continue;
    for (const desc of r.picks(RISK_POOL, r.int(1, j.isLong ? 3 : 2))) {
      const like = r.int(2, 5), imp = r.int(2, 5);
      const escalated = like + imp >= 8 && !j.isComplete;
      riskRows.push({
        j, row: {
          org_id: ORG_ID, job_id: j.id, description: desc, likelihood: like, impact: imp,
          mitigation: "Monitored weekly by the site supervisor; mitigation reviewed at each project meeting.",
          status: j.isComplete ? "closed" : r.weighted([["open", 4], ["mitigated", 2]]),
          owner: r.pick(OWNERS),
          escalated_at: escalated ? addDays(TODAY, -r.int(3, 30)).toISOString() : null,
          escalation_note: escalated ? `Score ${like + imp} (L${like}×I${imp}) — escalated to director review.` : "",
          created_by_ai: r.bool(0.25), created_at: addDays(j.start, r.int(2, Math.max(3, j.ageDays))).toISOString(),
        },
      });
    }
  }
  const riskIds = await insert("plat_con_risk",
    ["org_id", "job_id", "description", "likelihood", "impact", "mitigation", "status", "owner", "escalated_at", "escalation_note", "created_by_ai", "created_at"],
    riskRows.map((x) => x.row), { returning: "id" });
  riskRows.forEach((x, k) => { x.id = riskIds[k]?.id; });

  // ── workstreams + actions ──────────────────────────────────────────────────
  const rw = rng(SEED ^ 0x88);
  const wsCandidates = jobs.filter((j) => j.isLong && j.status === "active");
  const wsRows = await insert("plat_core_workstream",
    ["org_id", "job_id", "name", "description", "milestone", "status", "created_at", "last_updated"],
    wsCandidates.slice(0, 30).map((j) => ({
      org_id: ORG_ID, job_id: j.id, name: `${(phasesByJob[j.id] ?? []).find((p) => p.row.status === "in_progress")?.row.name ?? "Delivery"} — ${j.code}`,
      description: "Tasks tied to the current phase of works.", milestone: "Phase inspection passed",
      status: "active", created_at: j.start.toISOString(), last_updated: TODAY.toISOString(),
    })), { returning: "id, job_id" });
  const wsByJob = Object.fromEntries(wsRows.map((w) => [w.job_id, w.id]));

  const actionRows = [];
  for (const j of jobs) {
    const r = rng(SEED ^ 0x99 ^ (j.i * 2246822519));
    if (j.status === "intake") continue;
    const n = j.isComplete ? r.int(1, 2) : r.int(2, 4);
    for (const title of r.picks(ACTION_POOL, n)) {
      const due = j.isComplete ? addDays(j.target, -r.int(5, 40)) : addDays(TODAY, r.int(-15, 30));
      const status = j.isComplete ? "done" : r.weighted([["open", 4], ["in_progress", 2], ["done", 3]]);
      actionRows.push({
        org_id: ORG_ID, job_id: j.id, workstream_id: wsByJob[j.id] ?? null, title,
        detail: `${title} for ${j.code} (${j.cat.label}).`,
        priority: r.weighted([["P1", 2], ["P2", 5], ["P3", 2]]), status, owner: r.pick(OWNERS),
        due_date: isoDate(due), source_type: r.weighted([["manual", 5], ["chat", 2], ["meeting", 2]]),
        issue_type: "Open Action", created_at: addDays(due, -r.int(5, 20)).toISOString(), updated_at: TODAY.toISOString(),
      });
    }
  }
  await insert("plat_core_actionhub",
    ["org_id", "job_id", "workstream_id", "title", "detail", "priority", "status", "owner", "due_date", "source_type", "issue_type", "created_at", "updated_at"],
    actionRows);

  // ── decisions ──────────────────────────────────────────────────────────────
  const rd = rng(SEED ^ 0xaa);
  const decisionRows = [];
  for (let k = 0; k < 70; k++) {
    const j = rd.pick(jobs.filter((x) => x.status !== "intake"));
    const [desc, rationale, category] = rd.pick(DECISION_POOL);
    const made = rd.weighted([["confirmed", 5], ["proposed", 2], ["superseded", 1]]);
    const at = addDays(j.start, rd.int(5, Math.max(6, j.ageDays)));
    decisionRows.push({
      org_id: ORG_ID, job_id: j.id, description: `${desc} (${j.code})`, rationale, category,
      status: made, made_by: made === "proposed" ? AI_NAME : rd.pick(OWNERS),
      source_type: made === "proposed" ? "chat" : "manual",
      decided_at: made === "confirmed" ? at.toISOString() : null, created_at: at.toISOString(),
    });
  }
  await insert("plat_core_decision",
    ["org_id", "job_id", "description", "rationale", "category", "status", "made_by", "source_type", "decided_at", "created_at"],
    decisionRows);

  // ── variation orders ───────────────────────────────────────────────────────
  const rv2 = rng(SEED ^ 0xbb);
  const voJobs = jobs.filter((x) => x.isLong && x.status !== "intake");
  const voRows = [];
  const voSeq = {};
  for (let k = 0; k < 55; k++) {
    const j = rv2.pick(voJobs);
    voSeq[j.code] = (voSeq[j.code] ?? 0) + 1;
    const status = j.isComplete ? rv2.weighted([["approved", 5], ["rejected", 1]]) : rv2.weighted([["approved", 4], ["submitted", 3], ["draft", 2], ["rejected", 1]]);
    const cost = money(rv2, 1800, 42000, 100) * rv2.weighted([[1, 8], [-1, 2]]);
    const at = addDays(j.start, rv2.int(10, Math.max(11, j.ageDays)));
    const isAi = rv2.bool(0.3);
    const [desc] = rv2.pick(DECISION_POOL);
    voRows.push({
      org_id: ORG_ID, job_id: j.id, ref_number: `VO-${j.code.slice(4)}-${String(voSeq[j.code]).padStart(3, "0")}`,
      title: desc, description: `Client-requested change on ${j.code}.`,
      scope_change: `${desc}. Adjust affected trades and program accordingly.`,
      cost_impact: cost, time_impact_days: rv2.int(0, 12), status,
      is_ai_drafted: isAi, ai_draft: isAi ? J({ basis: "cost delta from vendor quotes", confidence: rv2.int(55, 90) }) : "{}",
      submitted_by: isAi ? `${AI_NAME} (AI)` : rv2.pick(OWNERS),
      approved_by: status === "approved" ? "Mac Antonio" : "",
      approved_at: status === "approved" ? addDays(at, rv2.int(2, 10)).toISOString() : null,
      created_at: at.toISOString(),
    });
  }
  await insert("plat_con_variationorder",
    ["org_id", "job_id", "ref_number", "title", "description", "scope_change", "cost_impact", "time_impact_days", "status", "is_ai_drafted", "ai_draft", "submitted_by", "approved_by", "approved_at", "created_at"],
    voRows);

  // ── change log (non-variation changes) ─────────────────────────────────────
  const rcl = rng(SEED ^ 0xcc);
  const clRows = [];
  const CL_TYPES = ["Scope Adjustment", "Delay Event", "Design Change", "Client Request", "Regulatory"];
  for (let k = 0; k < 40; k++) {
    const j = rcl.pick(jobs.filter((x) => x.status !== "intake"));
    const t = rcl.pick(CL_TYPES);
    const at = addDays(j.start, rcl.int(5, Math.max(6, j.ageDays)));
    const resolved = rcl.bool(0.6);
    clRows.push({
      org_id: ORG_ID, job_id: j.id, name: `${t} — ${j.code}`, change_type: t,
      description: `${t} recorded on ${j.cat.label.toLowerCase()} (${j.code}).`,
      status: resolved ? "resolved" : "open",
      impact_cost: money(rcl, 0, 15000, 50), impact_days: rcl.int(0, 10),
      date_raised: isoDate(at), date_resolved: resolved ? isoDate(addDays(at, rcl.int(3, 21))) : null,
      raised_by: rcl.pick(OWNERS), created_at: at.toISOString(),
    });
  }
  await insert("plat_con_changelog",
    ["org_id", "job_id", "name", "change_type", "description", "status", "impact_cost", "impact_days", "date_raised", "date_resolved", "raised_by", "created_at"],
    clRows);

  // ── quotes + lines ─────────────────────────────────────────────────────────
  const rq = rng(SEED ^ 0xdd);
  const quoteMeta = [];
  const quoteRows = [];
  for (let k = 0; k < 45; k++) {
    const linked = rq.bool(0.6);
    const j = linked ? rq.pick(jobs) : null;
    const status = j?.status === "complete" || (j && rq.bool(0.6)) ? "accepted" : rq.weighted([["draft", 2], ["sent", 3], ["rejected", 1], ["expired", 1]]);
    const nLines = rq.int(3, 6);
    const lines = rq.picks(QUOTE_ITEMS, nLines).map(([desc, cat, unit, range], li) => {
      const qty = unit === "m²" ? rq.int(20, 240) : 1;
      const unitPrice = unit === "m²" ? money(rq, range[0] / qty, range[1] / qty, 1) : money(rq, range[0], range[1], 50);
      return { description: desc, category: cat, qty, unit, unit_price: unitPrice, line_total: Math.round(qty * unitPrice * 100) / 100, sort_order: li + 1 };
    });
    const subtotal = Math.round(lines.reduce((s, l) => s + l.line_total, 0) * 100) / 100;
    const gst = Math.round(subtotal * 0.1 * 100) / 100;
    const at = j ? addDays(j.start, -rq.int(10, 45)) : addDays(TODAY, -rq.int(5, 300));
    const clientName = j ? j.row.name.split("— ")[1] : personName(rq) + ", " + rq.pick(SUBURBS);
    quoteMeta.push({ lines });
    quoteRows.push({
      org_id: ORG_ID, job_id: j?.id ?? null, ref_number: `Q-${at.getUTCFullYear()}-${String(k + 101)}`,
      title: `${j ? j.cat.label : rq.pick([...LONG_TYPES, ...SHORT_TYPES]).label} — ${clientName}`,
      client_name: clientName, status, gst_rate: 10, subtotal, gst_amount: gst, total: subtotal + gst,
      notes: status === "rejected" ? "Client proceeded with another builder." : "",
      valid_until: isoDate(addDays(at, 30)), is_ai_drafted: rq.bool(0.35), created_by: rq.pick(OWNERS),
      sent_at: status !== "draft" ? addDays(at, 1).toISOString() : null,
      decided_at: ["accepted", "rejected"].includes(status) ? addDays(at, rq.int(3, 20)).toISOString() : null,
      created_at: at.toISOString(), updated_at: at.toISOString(),
    });
  }
  const quoteIds = await insert("plat_con_quote",
    ["org_id", "job_id", "ref_number", "title", "client_name", "status", "gst_rate", "subtotal", "gst_amount", "total", "notes", "valid_until", "is_ai_drafted", "created_by", "sent_at", "decided_at", "created_at", "updated_at"],
    quoteRows, { returning: "id" });
  const quoteLineRows = [];
  quoteIds.forEach((qr, k) => {
    for (const l of quoteMeta[k].lines) quoteLineRows.push({ org_id: ORG_ID, quote_id: qr.id, ...l });
  });
  await insert("plat_con_quoteline",
    ["org_id", "quote_id", "description", "category", "qty", "unit", "unit_price", "line_total", "sort_order"],
    quoteLineRows);

  // ── documents ──────────────────────────────────────────────────────────────
  const rdoc = rng(SEED ^ 0xee);
  const docRows = [];
  for (const j of jobs) {
    if (j.status === "intake") continue;
    const n = j.isLong ? rdoc.int(2, 4) : rdoc.int(1, 2);
    for (const [title, docType, classification] of rdoc.picks(DOC_TYPES, n)) {
      const at = addDays(j.start, rdoc.int(0, Math.max(1, Math.min(j.ageDays, j.durDays))));
      const analyzed = docType === "contract" || rdoc.bool(0.3);
      docRows.push({
        org_id: ORG_ID, job_id: j.id, title: `${j.code} · ${title}`, kind: "file", doc_type: docType,
        classification, storage_provider: "local",
        storage_ref: `aamayah-stella-builders/${j.code}/${docType}/${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`,
        mime_type: "application/pdf", size_bytes: rdoc.int(80, 4200) * 1024,
        text_content: analyzed ? `${title} for ${j.code} (${j.cat.label}). Fixed-price residential works, progress claims per schedule, defects liability 12 months.` : "",
        ai_summary: analyzed ? `${title}: standard residential terms; key dates and claim schedule extracted.` : "",
        ai_analysis: analyzed ? J({ risks: ["Late selections shift joinery order window"], obligations: ["Progress claims per stage schedule"] }) : "{}",
        status: analyzed ? "analyzed" : "uploaded", uploaded_by: rdoc.pick(OWNERS),
        analyzed_at: analyzed ? addDays(at, 1).toISOString() : null, created_at: at.toISOString(),
      });
    }
  }
  await insert("plat_core_document",
    ["org_id", "job_id", "title", "kind", "doc_type", "classification", "storage_provider", "storage_ref", "mime_type", "size_bytes", "text_content", "ai_summary", "ai_analysis", "status", "uploaded_by", "analyzed_at", "created_at"],
    docRows);

  // ── meeting minutes + weekly reports (active long projects) ────────────────
  const rm = rng(SEED ^ 0xff);
  const activeLong = jobs.filter((x) => x.isLong && x.status === "active");
  const minutesRows = [];
  for (const j of activeLong.slice(0, 14)) {
    for (let m = 0; m < 2; m++) {
      const at = addDays(TODAY, -rm.int(3, 60));
      const actions = rm.picks(ACTION_POOL, 3).map((t) => ({ title: t, owner: rm.pick(OWNERS), dueDate: isoDate(addDays(at, rm.int(3, 14))) }));
      minutesRows.push({
        org_id: ORG_ID, job_id: j.id, meeting_date: isoDate(at),
        title: `Site meeting — ${j.code} (${monthKey(at)})`,
        attendees: "Mac Antonio, Stella Nguyen, Ravi Patel, Client",
        raw_minutes: `Walked the site. Discussed program versus claim schedule, current phase progress and trade coordination. ${actions.map((a) => `${a.owner} to ${a.title.toLowerCase()} by ${a.dueDate}.`).join(" ")}`,
        extracted_actions: J(actions), actions_count: actions.length,
        status: rm.weighted([["processed", 5], ["raw", 2]]),
        confirmed_at: rm.bool(0.6) ? addDays(at, 1).toISOString() : null, created_at: at.toISOString(),
      });
    }
  }
  await insert("plat_con_meetingminutes",
    ["org_id", "job_id", "meeting_date", "title", "attendees", "raw_minutes", "extracted_actions", "actions_count", "status", "confirmed_at", "created_at"],
    minutesRows);

  const reportRows = [];
  for (const j of activeLong.slice(0, 12)) {
    for (let w = 0; w < 4; w++) {
      const weekEnd = addDays(TODAY, -((TODAY.getUTCDay() + 2) % 7) - w * 7);
      const draft = w === 0;
      reportRows.push({
        org_id: ORG_ID, job_id: j.id, week_ending: isoDate(weekEnd),
        title: `Week ending ${isoDate(weekEnd)} — ${j.code}`,
        content: `## Progress\n- ${(phasesByJob[j.id] ?? []).find((p) => p.row.status === "in_progress")?.row.name ?? "Current phase"} tracking at ${j.row.completion_pct}% overall.\n- Trades on site: ${rm.picks(["carpenters", "plumbers", "electricians", "plasterers", "tilers", "painters"], 2).join(", ")}.\n\n## Budget\n- Claims to date consistent with completion; no new exposures this week.\n\n## Next week\n- ${rm.pick(ACTION_POOL)}.`,
        is_ai_generated: true, status: draft ? "draft" : "approved",
        generated_at: addDays(weekEnd, 1).toISOString(),
        approved_by: draft ? "" : "Mac Antonio",
        approved_at: draft ? null : addDays(weekEnd, 2).toISOString(),
      });
    }
  }
  await insert("plat_con_weeklyreport",
    ["org_id", "job_id", "week_ending", "title", "content", "is_ai_generated", "status", "generated_at", "approved_by", "approved_at"],
    reportRows);

  // ── comms ──────────────────────────────────────────────────────────────────
  const rc = rng(SEED ^ 0x1234);
  const commsRows = [];
  for (let k = 0; k < 110; k++) {
    const j = rc.pick(jobs.filter((x) => x.status !== "intake"));
    const [topic, type, role] = rc.pick(COMMS_POOL);
    const due = addDays(TODAY, rc.int(-45, 21));
    commsRows.push({
      org_id: ORG_ID, job_id: j.id, topic: `${topic} — ${j.code}`, message_type: type,
      stakeholder_role: role, status: due < TODAY ? "sent" : "pending",
      due_date: isoDate(due), sent_by: due < TODAY ? rc.pick(OWNERS) : "",
      notes: "", created_at: addDays(due, -rc.int(1, 10)).toISOString(),
    });
  }
  await insert("plat_core_comms",
    ["org_id", "job_id", "topic", "message_type", "stakeholder_role", "status", "due_date", "sent_by", "notes", "created_at"],
    commsRows);

  // ── BIM models + portal tokens ─────────────────────────────────────────────
  const bigActive = [...activeLong].sort((a, b) => b.row.budget_total - a.row.budget_total).slice(0, 5);
  await insert("plat_con_bimmodel",
    ["org_id", "job_id", "name", "provider", "embed_url", "client_visible", "added_by", "notes"],
    bigActive.slice(0, 4).map((j) => ({
      org_id: ORG_ID, job_id: j.id, name: `${j.code} — coordination model`, provider: "bimx",
      embed_url: `https://bimx.graphisoft.com/embed/demo-${j.code.toLowerCase()}`,
      client_visible: true, added_by: "Stella Nguyen", notes: "Updated after latest design revision.",
    })));
  const rt = rng(SEED ^ 0x5678);
  const hex = "0123456789abcdef";
  const mkToken = () => Array.from({ length: 64 }, () => hex[rt.int(0, 15)]).join("");
  await insert("plat_con_portaltoken",
    ["org_id", "job_id", "token", "label", "is_active", "views_count", "expires_at"],
    bigActive.map((j) => ({
      org_id: ORG_ID, job_id: j.id, token: mkToken(), label: `Client portal — ${j.code}`,
      is_active: true, views_count: rt.int(0, 40), expires_at: addDays(TODAY, 180).toISOString(),
    })));

  // ── chat sessions + messages + pending writes (approvals inbox) ────────────
  const rch = rng(SEED ^ 0x9abc);
  const chatJobs = activeLong.slice(0, 6);
  const sessions = await insert("plat_core_chatsession",
    ["org_id", "job_id", "title", "started_at", "summary"],
    chatJobs.map((j, k) => ({
      org_id: ORG_ID, job_id: j.id, title: rch.pick(["Budget check-in", "Program review", "Claim preparation", "Risk review", "Variation discussion", "Cashflow forecast"]) + ` — ${j.code}`,
      started_at: addDays(TODAY, -rch.int(1, 20)).toISOString(),
      summary: "",
    })), { returning: "id, job_id" });
  const msgRows = [];
  const pendingSeeds = [];
  sessions.forEach((s, k) => {
    const j = chatJobs[k];
    const exchanges = [
      [`How is ${j.code} tracking against budget this month?`, `${j.code} is at ${j.row.completion_pct}% completion. Claims to date are consistent with progress; the largest exposure is the current phase's committed costs. I'll flag any budget line where actuals exceed 95% of budget.`],
      ["Any risks I should look at before Friday's site meeting?", "Two open risks score 8+ (likelihood × impact). I recommend reviewing the escalated one before the meeting — mitigation was last updated over two weeks ago."],
      ["Draft the next progress claim for this job.", `I've drafted progress claim details based on ${j.row.completion_pct}% completion and the stage schedule. This is a proposed write — it needs your approval before anything is recorded.`],
    ];
    for (const [u, a] of exchanges.slice(0, rch.int(2, 3))) {
      msgRows.push({ org_id: ORG_ID, session_id: s.id, role: "user", content: u, tool_calls: "[]" });
      msgRows.push({ org_id: ORG_ID, session_id: s.id, role: "assistant", content: a, tool_calls: "[]" });
    }
    pendingSeeds.push(j);
  });
  await insert("plat_core_chatmessage", ["org_id", "session_id", "role", "content", "tool_calls"], msgRows);

  await insert("plat_core_pendingwrite",
    ["org_id", "job_id", "table_key", "op", "payload", "actor_type", "actor_name", "status", "expires_at", "created_at"],
    pendingSeeds.slice(0, 8).map((j, k) => ({
      org_id: ORG_ID, job_id: j.id,
      table_key: k % 3 === 0 ? "risk" : k % 3 === 1 ? "cashflow" : "action",
      op: "create",
      payload: k % 3 === 0
        ? J({ description: `AI-suggested risk for ${j.code}: ${rch.pick(RISK_POOL)}`, likelihood: rch.int(2, 5), impact: rch.int(2, 5), jobId: j.id })
        : k % 3 === 1
          ? J({ name: `${j.code} · Progress claim (draft)`, type: "In", amount: Math.round(j.row.budget_total * 0.1), period: monthKey(TODAY), status: "Forecast", jobId: j.id })
          : J({ title: rch.pick(ACTION_POOL), priority: "P2", owner: "Stella Nguyen", jobId: j.id }),
      actor_type: "ai", actor_name: AI_NAME, status: "proposed",
      expires_at: addDays(TODAY, 7).toISOString(), created_at: TODAY.toISOString(),
    })));

  // ── learning loop: hypotheses → corrections → rules ────────────────────────
  const rl = rng(SEED ^ 0xdef0);
  const HYPS = [
    ["Concrete and footing costs run ~8–12% over estimate on sloping sites.", "budget.foundation", "site cut and fill underestimated"],
    ["Joinery lead times slip when client selections arrive after frame stage.", "schedule.joinery", "late client selections"],
    ["Painting quotes come in under budget on single-storey builds.", "budget.painting", "single-storey access premium overestimated"],
    ["Wet-season slab pours add 5–9 days versus program.", "schedule.foundation", "seasonal rainfall not in baseline program"],
    ["Electrical fitoff actuals exceed estimate when clients add smart-home scope.", "budget.electrical", "scope growth at fitoff"],
  ];
  const hypIds = await insert("plat_core_hypothesis",
    ["org_id", "description", "dimension", "root_cause_pattern", "sample_count", "avg_variance_pct", "confidence", "status", "source_type", "created_at"],
    HYPS.map(([d, dim, root], k) => ({
      org_id: ORG_ID, description: d, dimension: dim, root_cause_pattern: root,
      sample_count: rl.int(3, 9), avg_variance_pct: Math.round(rl.next() * 140 + 40) / 10,
      confidence: rl.int(35, 85), status: rl.weighted([["pending", 3], ["accepted", 2]]),
      source_type: "correction", created_at: addDays(TODAY, -rl.int(20, 200)).toISOString(),
    })), { returning: "id" });
  const corrRows = [];
  for (let k = 0; k < 15; k++) {
    const hi = k % HYPS.length;
    const j = rl.pick(jobs.filter((x) => x.status !== "intake"));
    const ai = money(rl, 8000, 90000, 100);
    const human = Math.round(ai * (1 + (rl.next() * 0.24 - 0.06)) / 10) * 10;
    corrRows.push({
      org_id: ORG_ID, job_id: j.id, entity_type: "budget_line", dimension: HYPS[hi][1],
      ai_value: ai, human_value: human, variance_pct: Math.round(((human - ai) / ai) * 1000) / 10,
      root_cause: HYPS[hi][2], corrected_by: rl.pick(OWNERS), hypothesis_id: hypIds[hi]?.id ?? null,
      source_module: "budget", correction_direction: human > ai ? "up" : "down",
      created_at: addDays(TODAY, -rl.int(5, 180)).toISOString(),
    });
  }
  await insert("plat_core_correction",
    ["org_id", "job_id", "entity_type", "dimension", "ai_value", "human_value", "variance_pct", "root_cause", "corrected_by", "hypothesis_id", "source_module", "correction_direction", "created_at"],
    corrRows);
  await insert("plat_core_learningrule",
    ["org_id", "rule_code", "kind", "description", "category", "dimension", "confidence", "times_triggered", "is_active", "auto_apply", "cannot_override", "source_hypothesis_id", "date_activated"],
    [
      { org_id: ORG_ID, rule_code: "LRN-0001", kind: "estimate_adjustment", description: "Add 10% contingency to foundation estimates on sloping blocks.", category: "Budget", dimension: "budget.foundation", confidence: 82, times_triggered: 23, is_active: true, auto_apply: false, cannot_override: false, source_hypothesis_id: hypIds[0]?.id ?? null, date_activated: addDays(TODAY, -120).toISOString() },
      { org_id: ORG_ID, rule_code: "LRN-0002", kind: "guidance", description: "Lock client selections before frame stage to protect the joinery order window.", category: "Schedule", dimension: "schedule.joinery", confidence: 76, times_triggered: 14, is_active: true, auto_apply: false, cannot_override: false, source_hypothesis_id: hypIds[1]?.id ?? null, date_activated: addDays(TODAY, -90).toISOString() },
      { org_id: ORG_ID, rule_code: "LRN-0003", kind: "guidance", description: "Add 7 program days to any slab pour scheduled between December and March.", category: "Schedule", dimension: "schedule.foundation", confidence: 71, times_triggered: 9, is_active: true, auto_apply: false, cannot_override: false, source_hypothesis_id: hypIds[3]?.id ?? null, date_activated: addDays(TODAY, -60).toISOString() },
      { org_id: ORG_ID, rule_code: "LRN-0004", kind: "guidance", description: "Never issue a progress claim without reconciling the cashflow ledger first.", category: "Finance", dimension: "", confidence: 95, times_triggered: 31, is_active: true, auto_apply: false, cannot_override: true, source_hypothesis_id: null, date_activated: addDays(TODAY, -150).toISOString() },
      { org_id: ORG_ID, rule_code: "LRN-0005", kind: "estimate_adjustment", description: "Reduce painting estimates 5% on single-storey builds.", category: "Budget", dimension: "budget.painting", confidence: 58, times_triggered: 4, is_active: false, auto_apply: false, cannot_override: false, source_hypothesis_id: hypIds[2]?.id ?? null, date_activated: null },
    ]);

  // ── execution log + intelligence snapshots + assessments ───────────────────
  const re = rng(SEED ^ 0x2468);
  const execRows = [];
  const EXEC_OPS = [
    ["ai", AI_NAME, "generate", "plat_con_weeklyreport", "Draft weekly report generated"],
    ["ai", AI_NAME, "create", "plat_con_variationorder", "AI draft VO created (pending approval)"],
    ["ai", AI_NAME, "create", "plat_core_actionhub", "Action created from chat"],
    ["human", "Stella Nguyen", "update", "plat_con_budgetline", "Actuals updated from vendor invoice"],
    ["human", "Ravi Patel", "update", "plat_con_phase", "Phase completion updated after inspection"],
    ["human", "Grace Muller", "create", "plat_con_cashflowledger", "Progress claim recorded"],
    ["system", "off_system_change", "update", "plat_con_cashflowledger", "Imported from bank export"],
    ["human", "Mac Antonio", "approve", "plat_core_pendingwrite", "AI proposal approved"],
  ];
  for (let k = 0; k < 90; k++) {
    const j = re.pick(jobs.filter((x) => x.status !== "intake"));
    const [actorType, actorName, op, table, result] = re.pick(EXEC_OPS);
    const at = addDays(TODAY, -re.int(0, 200));
    execRows.push({
      org_id: ORG_ID, job_id: j.id, actor_type: actorType, actor_name: actorName, operation: op,
      target_table: table, payload: J({ jobCode: j.code }), result, status: "executed",
      executed_at: at.toISOString(), created_at: at.toISOString(),
    });
  }
  await insert("plat_core_executionlog",
    ["org_id", "job_id", "actor_type", "actor_name", "operation", "target_table", "payload", "result", "status", "executed_at", "created_at"],
    execRows);

  const snapRows = [];
  for (let m = 6; m >= 0; m--) {
    const at = addDays(TODAY, -m * 30);
    const done = jobs.filter((x) => x.isComplete && x.target <= at).length;
    const total = jobs.filter((x) => x.start <= at).length;
    snapRows.push({
      org_id: ORG_ID, captured_at: at.toISOString(), total_jobs: total, completed_jobs: done,
      accuracy_rate_pct: Math.round((78 + (6 - m) * 1.6 + re.next() * 3) * 10) / 10,
      active_rules: 7 + Math.max(0, 5 - m), auto_apply_rules: 0,
      avg_confidence: Math.round((60 + (6 - m) * 2.5) * 10) / 10,
      top_rules: J(["LRN-0004", "LRN-0001", "LRN-0002"]), gaps: J(m > 3 ? ["electrical fitoff estimates"] : []),
      metrics: J({ correctionsThisPeriod: re.int(0, 4) }),
    });
  }
  await insert("plat_core_intelligencesnapshot",
    ["org_id", "captured_at", "total_jobs", "completed_jobs", "accuracy_rate_pct", "active_rules", "auto_apply_rules", "avg_confidence", "top_rules", "gaps", "metrics"],
    snapRows);

  const ra = rng(SEED ^ 0x1357);
  const assessRows = [];
  for (let k = 0; k < 12; k++) {
    const cat = ra.pick([...LONG_TYPES, ...SHORT_TYPES]);
    const suburb = ra.pick(SUBURBS);
    const done = ra.bool(0.7);
    assessRows.push({
      org_id: ORG_ID, name: `${cat.label} enquiry — ${personName(ra)}, ${suburb}`,
      engagement_type: LONG_TYPES.includes(cat) ? "long_project" : "short_job",
      address: `${ra.int(1, 180)} ${ra.pick(STREETS)}`, suburb,
      size_sqm: ra.int(60, 420), scope: `${cat.label} — initial scoping from client enquiry.`,
      result: done ? J({ estimateLow: money(ra, cat.budget[0], cat.budget[1], 500), estimateHigh: money(ra, cat.budget[1], cat.budget[1] * 1.2, 500), confidence: ra.int(55, 85) }) : "{}",
      status: done ? "complete" : "draft", created_by: ra.pick(OWNERS),
      created_at: addDays(TODAY, -ra.int(2, 120)).toISOString(),
    });
  }
  await insert("plat_core_assessment",
    ["org_id", "name", "engagement_type", "address", "suburb", "size_sqm", "scope", "result", "status", "created_by", "created_at"],
    assessRows);

  // ── control plane: point generalJobId at the General bucket ────────────────
  if (!DRY && generalJobId) {
    const cur = await runSql(CONTROL_REF, `SELECT settings FROM plat_core_organisation WHERE id = ${ORG_ID}`);
    const settings = JSON.parse(cur[0].settings || "{}");
    if (!settings.generalJobId) {
      settings.generalJobId = String(generalJobId);
      await runSql(CONTROL_REF, `UPDATE plat_core_organisation SET settings = ${q(J(settings))} WHERE id = ${ORG_ID}`);
      console.log(`  ✓ control settings.generalJobId = ${generalJobId}`);
    }
  }

  const total = Object.values(totalsByTable).reduce((a, b) => a + b, 0);
  console.log(`\nDONE — ${total} rows across ${Object.keys(totalsByTable).length} tables (${reqCount} API requests).`);
  console.table(totalsByTable);
}

main().catch((e) => { console.error("\nSEED FAILED:", e.message); process.exit(1); });
