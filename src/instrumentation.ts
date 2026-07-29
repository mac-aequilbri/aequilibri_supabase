// Startup guard for the data-backend flag (docs/airtable-postgres-switch-audit.md,
// Phase A). AIRTABLE_MIGRATION is a process-wide, one-way migration lever — the
// two backends are not feature-equivalent, so a misconfigured flag should fail
// loud in the boot log rather than at the first affected request.
//
// Env is read directly (mirrors airtableEnabled()/controlEnabled()) so this file
// stays import-free and runs before any app module.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const warn = (msg: string) => console.warn(`[backend-guard] ${msg}`);
  const airtableOn = process.env.AIRTABLE_MIGRATION === "true";
  const controlOn = Boolean(process.env.AIRTABLE_CONTROL_BASE_ID);

  // Always state the resolved mode so every boot log answers "which backend?"
  console.info(
    `[backend-guard] data backend: ${airtableOn ? "airtable" : "postgres"} (control base ${controlOn ? "on" : "off"})`,
  );

  if (!airtableOn) {
    warn(
      "AIRTABLE_MIGRATION is off — all reads/writes use Postgres (orgs cannot opt back " +
        "into Airtable per-org). " +
        "Control-plane features (assignments, connections, outbox, catalogs) are unavailable, " +
        "and cascade write-effects/advisories do not fire (engine is Airtable-gated).",
    );
    return;
  }

  if (!process.env.AIRTABLE_PAT) {
    warn("AIRTABLE_MIGRATION=true but AIRTABLE_PAT is unset — every Airtable call will fail.");
  }
  if (!controlOn) {
    warn(
      "AIRTABLE_MIGRATION=true without AIRTABLE_CONTROL_BASE_ID — org identity, team and RLS " +
        "fall back to Postgres; assignments/connections/outbox/catalogs are unavailable.",
    );
  }
  if (!process.env.DATABASE_URL) {
    warn(
      "DATABASE_URL is unset — Postgres is still a hard dependency in Airtable mode " +
        "(failure audit rows, pending-write claims, UC1).",
    );
  }
}
