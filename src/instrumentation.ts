// Startup guard for the data backend (migration-plan Phase 6): Postgres is the
// only backend. A missing database URL should fail loud in the boot log rather
// than at the first affected request.
//
// Env is read directly so this file stays import-free and runs before any app
// module.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const warn = (msg: string) => console.warn(`[backend-guard] ${msg}`);

  // Always state the resolved mode so every boot log answers "which backend?"
  console.info("[backend-guard] data backend: postgres");

  if (!process.env.DATABASE_URL) {
    warn("DATABASE_URL is unset — Postgres is a hard dependency; every tenant read/write will fail.");
  }
  if (!process.env.CONTROL_DATABASE_URL) {
    warn(
      "CONTROL_DATABASE_URL is unset — the control-plane database (org registry, team, RLS) is unreachable.",
    );
  }
}
