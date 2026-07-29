// Native Postgres RLS pin for a provisioned tenant database (§2b rule 4).
//
// Each tenant database holds exactly ONE org, so the policy is a constant
// pin, not a session variable: every org_id-bearing table gets
//   ENABLE + FORCE ROW LEVEL SECURITY
//   POLICY org_pin USING (org_id = <orgId>) WITH CHECK (org_id = <orgId>)
// Wrong-DB wiring bugs then hit a wall INSIDE Postgres, beneath both the app
// guard (lib/db.ts) and the orgId columns (§2b rule 3).
//
// Caveat: superusers and BYPASSRLS roles bypass policies even with FORCE.
// Local dev connects as the cluster owner, so the pin is inert there; in
// production the app must connect as a plain role (Phase 7 checklist).
//
// Idempotent — re-run after every migration fan-out so new tables get pinned.

/** Apply the org pin to every org_id table in the connected database.
 *  `client` is a PrismaClient connected to THAT tenant database. */
export async function applyTenantRlsPin(client, orgId) {
  if (!Number.isInteger(orgId) || orgId <= 0) throw new Error(`bad orgId: ${orgId}`);
  const tables = await client.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'org_id'`,
  );
  let pinned = 0;
  for (const { table_name: t } of tables) {
    await client.$executeRawUnsafe(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
    await client.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
    await client.$executeRawUnsafe(`DROP POLICY IF EXISTS org_pin ON "${t}"`);
    await client.$executeRawUnsafe(
      `CREATE POLICY org_pin ON "${t}" USING (org_id = ${orgId}) WITH CHECK (org_id = ${orgId})`,
    );
    pinned++;
  }
  return pinned;
}
