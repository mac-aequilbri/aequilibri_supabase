// Airtable migration — activation + base resolution.
//
// The whole Airtable data layer is inert unless AIRTABLE_MIGRATION=true, so it
// can land in the tree without affecting the live Postgres path. The PAT is
// read from the environment (never hard-coded; .env is gitignored).
//
// Per-customer base model: each client is its own cloned Airtable base, so a
// request must resolve to that client's baseId. The canonical home is the
// PlatOrganisation.airtableBaseId column (set at provisioning); AIRTABLE_BASES
// (a JSON object of { orgSlug: baseId }) is the legacy/override fallback, with
// the demo base as the development default.

import { prisma } from "@/lib/db";

/** Demo base (AEQUILIBRI_DIDI_DEMO) — the only base the dev PAT can reach. */
export const DEMO_BASE_ID = "appharWaojouHgMeW";

/** Master Template per the build spec — not reachable with the demo PAT yet. */
export const MASTER_TEMPLATE_BASE_ID = "appIf959oh38fgKYp";

/** Vertical template bases (Spec 12, confirmed production-ready 29 June 2026).
 *  MASTER_TEMPLATE_BASE_ID is the canonical schema reference only and is never
 *  cloned directly for customers — every vertical clones its own template
 *  (Core + that vertical's Domain Extension tables). Add an entry here only
 *  once a vertical's Domain Extension (reference tables + DOMAIN_LABELS +
 *  assessment module) has actually been built. */
export const VERTICAL_TEMPLATE_BASE_IDS: Record<string, string> = {
  construction: "appXfwBLE6zBEL5Zr",
  roofing: "appDSGE0EcAf2pRDZ",
};

/** Resolve a customer's vertical to the template its base should be cloned
 *  from. Throws for any vertical without a built template — onboarding must
 *  fail loudly rather than silently fall back to the Core Template. */
export function templateBaseIdForVertical(vertical: string): string {
  const id = VERTICAL_TEMPLATE_BASE_IDS[vertical];
  if (!id) {
    throw new Error(
      `No Airtable template exists yet for vertical "${vertical}" — build its Domain Extension ` +
        `(reference tables + DOMAIN_LABELS + assessment module) before onboarding a customer in it.`,
    );
  }
  return id;
}

/** Feature flag. Nothing in this layer activates unless explicitly enabled.
 *
 *  Scope honesty (see docs/airtable-postgres-switch-audit.md): this is a
 *  PROCESS-WIDE, ONE-WAY migration lever, not a per-org backend selector.
 *  Flipping it moves every org at once, and the two backends are not
 *  feature-equivalent — off: the control plane is unavailable and cascade
 *  write-effects don't fire (COMMS/PLAN/CASHFLOWS gained Postgres models in
 *  Phases D and migration-plan Phase 2); on: Postgres remains a hard
 *  dependency (failure audit rows, pending-write claims, UC1). There is no
 *  data migration attached to the flag — flipping it strands existing rows
 *  on the previous backend (scripts/migration/ moves them). src/instrumentation.ts
 *  logs these asymmetries at boot.
 *
 *  Phase D per-org override: pass the org context wherever org data is being
 *  read or written, and the org's `data_backend_postgres` feature (org registry
 *  Settings JSON → {"features":{"data_backend_postgres":true}}) opts THAT org
 *  back onto Postgres while the rest of the platform stays on Airtable — the
 *  per-org escape hatch for staged migration in either direction. Call sites
 *  without an org in scope (control plane, health, boot) stay on the global
 *  env decision. */
export function airtableEnabled(
  ctx?: { config?: { features?: Record<string, boolean> } } | null,
): boolean {
  if (ctx?.config?.features?.["data_backend_postgres"]) return false;
  return process.env.AIRTABLE_MIGRATION === "true";
}

/** The personal access token. Throws if asked for while unset, so a
 *  misconfiguration is a loud failure rather than a silent no-op. */
export function airtablePat(): string {
  const pat = process.env.AIRTABLE_PAT;
  if (!pat) {
    throw new Error("AIRTABLE_PAT is not set — cannot reach the Airtable API.");
  }
  return pat;
}

function baseRegistry(): Record<string, string> {
  const raw = process.env.AIRTABLE_BASES;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Resolve an org slug to its Airtable base id. Resolution order:
 *   1. the org's provisioned `airtableBaseId` column (the canonical home), then
 *   2. the AIRTABLE_BASES env map (legacy / not-yet-provisioned orgs), then
 *   3. the demo base in development.
 *  Throws in production when none match, so a misconfigured org fails loudly.
 *  The DB lookup is best-effort: if Postgres is unreachable we still fall back
 *  to the env map, and the cost is negligible next to the Airtable round-trip. */
export async function resolveBaseId(orgSlug: string): Promise<string> {
  // Control plane first: when the org registry lives in Airtable, the slug→base
  // mapping comes from there (no Postgres). Dynamic import avoids a config↔
  // control module cycle.
  const { controlEnabled, getOrgRegistry } = await import("./control");
  if (controlEnabled()) {
    const entry = await getOrgRegistry(orgSlug).catch(() => null);
    if (entry?.airtableBaseId) return entry.airtableBaseId;
  } else {
    const org = await prisma.platOrganisation
      .findUnique({ where: { slug: orgSlug }, select: { airtableBaseId: true } })
      .catch(() => null);
    if (org?.airtableBaseId) return org.airtableBaseId;
  }

  const registry = baseRegistry();
  if (registry[orgSlug]) return registry[orgSlug];
  if (process.env.NODE_ENV !== "production") return DEMO_BASE_ID;
  throw new Error(`No Airtable base mapped for org "${orgSlug}" (provision its base or set AIRTABLE_BASES).`);
}
