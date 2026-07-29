// Customer Onboarding Engine (module 1) — provisions a configured,
// ready-to-learn customer instance in one transaction. Covers both
// sub-processes from the architecture doc:
//   Instance Setup: org row (the "clone" — Core schema is shared, so a new
//     instance is configuration, not new tables), customer-config defaults,
//     first admin.
//   Domain Knowledge Initialisation: the customer's rules of thumb encoded
//     as guidance learning rules before any jobs run, so the assistant
//     starts with something to work from.

import { airtableEnabled, core } from "@/lib/airtable";
import { templateBaseIdForVertical } from "@/lib/airtable/config";
import {
  controlEnabled,
  createControlTeamMember,
  createOrgRegistry,
  getOrgRegistry,
} from "@/lib/platform/controlPlane";
import { airtableMapFor, toFields } from "@/lib/airtable/fieldMaps";
import { ensureAppRuntimeTables, probeBaseDataAccess, provisionClientBase } from "@/lib/airtable/provision";
import { controlDb, prisma } from "@/lib/db";
import { logger, errMeta } from "@/lib/logger";
import { CASCADE_RULE_SEEDS } from "@/lib/platform/cascade";
import { defaultModule1Governance, normalizeTeamRole, type TeamRole } from "@/lib/platform/module1Governance";
import { DEFAULT_FEATURES, EngagementType, AiAuthority } from "@/lib/platform/types";
import { ensureJobCatalog } from "@/services/platform/jobCatalogGenerator";

/** The learning-engine threshold settings seeded for every new org. */
const SEED_SETTINGS: Array<{ key: string; value: string }> = [
  { key: "learning.hypothesis_min_samples", value: "3" },
  { key: "learning.rule_min_samples", value: "5" },
  { key: "learning.auto_apply_min_confidence", value: "85" },
  { key: "learning.auto_apply_min_triggers", value: "50" },
];

function refCode(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100);
}

function parseTradeLine(line: string): { trade: string; category: string; item: string } | null {
  const parts = line.split(/\s*(?:>|[|])\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return { trade: parts[0], category: "", item: parts[0] };
  if (parts.length === 2) return { trade: parts[0], category: parts[1], item: parts[1] };
  return { trade: parts[0], category: parts[1], item: parts.slice(2).join(" / ") };
}

function referenceSeedRows(
  categories: string[],
  clientPriorities: string[],
  tradeReferences: string[],
): Array<{ type: string; code: string; name: string; value: string; sortOrder: number }> {
  const rows: Array<{ type: string; code: string; name: string; value: string; sortOrder: number }> = [];
  const seen = new Set<string>();
  const push = (type: string, name: string, value: string, sortOrder: number) => {
    const code = refCode(name || value || type);
    const key = `${type}:${code}`;
    if (!name || seen.has(key)) return;
    seen.add(key);
    rows.push({ type, code, name, value, sortOrder });
  };

  categories.forEach((name, i) => push("budget_category", name, "{}", i));
  clientPriorities.forEach((name, i) =>
    push("client_priority", name, JSON.stringify({ source: "onboarding", priority: i + 1 }), i),
  );
  tradeReferences.forEach((line, i) => {
    const parsed = parseTradeLine(line);
    if (!parsed) return;
    push("trade", parsed.trade, JSON.stringify(parsed), i);
    if (parsed.category) push("trade_category", `${parsed.trade} / ${parsed.category}`, JSON.stringify(parsed), i);
    push("trade_item", `${parsed.trade} / ${parsed.item}`, JSON.stringify(parsed), i);
  });

  return rows;
}

/** Mirror the org's Customer Config (budget categories + learning settings)
 *  into its Airtable base, so the Airtable-backed reads (configSource,
 *  getLearningSettings) see the same data the Postgres txn just wrote. Best
 *  effort: a mirror failure must not fail onboarding (Postgres remains the
 *  fallback during the cutover), so callers swallow errors. */
// Governance §6 onboarding metadata: one ENGAGEMENT_TYPE_CONFIG record per
// active engagement type (canonical option names per the framework doc).
const ENGAGEMENT_TYPE_OPTION: Record<string, string> = {
  short_job: "Short Job",
  long_project: "Long Project",
  ongoing: "Ongoing Lifecycle",
  seasonal: "Seasonal Cycle",
};

async function seedEngagementTypeConfig(
  orgSlug: string,
  allowed: string[],
  defaultType: string,
): Promise<void> {
  for (const t of allowed) {
    const option = ENGAGEMENT_TYPE_OPTION[t];
    if (!option) continue;
    await core.create(orgSlug, "ENGAGEMENT_TYPE_CONFIG", {
      Config_Name: `${option}${t === defaultType ? " (default)" : ""}`,
      Engagement_Type: option,
      Active: true,
      Notes: "Seeded at onboarding (governance §6).",
    });
  }
}

async function mirrorConfigToBase(
  orgSlug: string,
  categories: string[],
  rules: string[],
  clientPriorities: string[],
  tradeReferences: string[],
): Promise<void> {
  for (const row of referenceSeedRows(categories, clientPriorities, tradeReferences)) {
    await core.create(orgSlug, "PLAT_CFG_REFERENCE", {
      Name: row.name,
      Ref_Type: row.type,
      Code: row.code,
      Value: row.value,
      Sort_Order: row.sortOrder,
      Is_Active: true,
    });
  }
  for (const s of SEED_SETTINGS) {
    await core.create(orgSlug, "PLAT_CFG_SETTING", { Setting_Key: s.key, Value: s.value });
  }
  // Seed guidance rules — through the learning_rule field map so they read back
  // identically to engine/promotion-created rules.
  const ruleMap = airtableMapFor("learning_rule")!;
  let seq = 0;
  for (const description of rules) {
    seq += 1;
    const fields = toFields(
      ruleMap,
      {
        ruleCode: `LRN-${String(seq).padStart(4, "0")}`,
        kind: "guidance",
        description,
        confidence: 80,
        isActive: true,
        autoApply: false,
        cannotOverride: false,
      },
      "create",
    );
    await core.create(orgSlug, "LEARNING_RULES", fields);
  }
  // Spec 12 Module 5 cascade rules (lock plan §5.1 / decision D-4): advisory
  // rules (A/B/C/E) seed Active; write-effect rules (D/F/G) seed as Drafts the
  // owner activates in the learning UI. The Owner_Only governance stamp is
  // best-effort (the Override_Level column lands via schema-drift migration).
  for (const seed of CASCADE_RULE_SEEDS) {
    const rec = await core.create(
      orgSlug,
      "LEARNING_RULES",
      toFields(
        ruleMap,
        {
          ruleCode: seed.ruleCode,
          kind: "guidance",
          description: seed.description,
          triggerCondition: seed.triggerCondition,
          confidence: 80,
          isActive: seed.isActive,
          autoApply: false,
          cannotOverride: false,
        },
        "create",
      ),
    );
    await core
      .update(orgSlug, "LEARNING_RULES", rec.id, { Override_Level: "Owner_Only" })
      .catch(() => {});
  }
}

export interface ProvisionInput {
  slug: string;
  name: string;
  vertical?: string;
  defaultEngagementType: EngagementType;
  allowedEngagementTypes: EngagementType[];
  aiAuthority: AiAuthority;
  assistantName: string;
  assistantPersona: string;
  features: Record<string, boolean>;
  adminName: string;
  adminEmail: string;
  adminRole: TeamRole;
  /** An existing Airtable base to reuse instead of provisioning a fresh one
   *  (blank = auto-create by cloning the template). */
  airtableBaseId?: string;
  /** Template base to clone from, resolved from the template registry by the
   *  onboarding action. When set it wins; otherwise the vertical is resolved via
   *  the hardcoded VERTICAL_TEMPLATE_BASE_IDS fallback. */
  templateBaseId?: string;
  /** One per line from the form: budget categories for the cfg reference tier. */
  budgetCategories: string[];
  /** One per line: client priorities / budget principles for later reference. */
  clientPriorities: string[];
  /** One per line: Trade > Category > Item. */
  tradeReferences: string[];
  /** Domain knowledge init: expert rules of thumb, one per line. */
  initialRules: string[];
  /** Company logo as a data URL, stored inline in settings.branding.logo. */
  logoDataUrl?: string;
  /** Human industry / sub-industry (from the template registry) — used to draft
   *  a job-category catalog for a brand-new vertical at onboarding. */
  industryLabel?: string;
  subIndustryLabel?: string;
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,98}$/;
/** Slugs that collide with static routes or would be confusing. */
const RESERVED_SLUGS = new Set(["new", "app", "portal", "api", "uc1", "uc2", "uc3"]);

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export type ProvisionResult =
  | { ok: true; orgId: number; slug: string }
  | { ok: false; error: string };

export async function provisionOrganisation(input: ProvisionInput): Promise<ProvisionResult> {
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug) || RESERVED_SLUGS.has(slug)) {
    return { ok: false, error: "Slug must be lowercase letters/numbers/hyphens (and not a reserved word)." };
  }
  if (!input.name.trim()) return { ok: false, error: "Organisation name is required." };

  const allowed = input.allowedEngagementTypes.length
    ? input.allowedEngagementTypes
    : [input.defaultEngagementType];
  const vertical = input.vertical ?? "construction";
  const settings = JSON.stringify({
    assistant: {
      name: input.assistantName.trim() || "Assistant",
      persona:
        input.assistantPersona.trim() ||
        `You are the AI project coordinator for ${input.name.trim()}. Be precise, data-driven, and flag risks proactively.`,
    },
    features: { ...DEFAULT_FEATURES, ...input.features },
    module1: defaultModule1Governance(),
    ...(input.logoDataUrl ? { branding: { logo: input.logoDataUrl } } : {}),
  });

  // Slug uniqueness — the control plane resolves the store.
  const exists = (await getOrgRegistry(slug)) !== null;
  if (exists) {
    return { ok: false, error: `An organisation with slug "${slug}" already exists.` };
  }

  // Airtable mode: provision the customer's own base by cloning the vertical
  // template's structure via the API (the app computes the template's few
  // rollup/formula values itself — see budgetActuals — so it doesn't depend on
  // those fields existing natively in the clone). An existing base id may be
  // supplied to skip creation (e.g. a base duplicated manually in Airtable).
  // Then create the app-runtime tables the template doesn't carry, verify
  // record-level read/write access, and register the org. Org identity/team
  // stay in Postgres; Customer Config + seed rules are mirrored in afterwards.
  let airtableBaseId: string | null = null;
  if (airtableEnabled()) {
    // Prefer the registry-resolved template (passed by the onboarding action);
    // fall back to the hardcoded per-vertical map when absent.
    let templateBaseId: string;
    try {
      templateBaseId = input.templateBaseId?.trim() || templateBaseIdForVertical(vertical);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    const supplied = (input.airtableBaseId ?? "").trim();
    if (supplied) {
      if (!/^app[A-Za-z0-9]{14,}$/.test(supplied)) {
        return { ok: false, error: `"${supplied}" is not a valid Airtable base id (expected e.g. appXXXXXXXXXXXXXX).` };
      }
      airtableBaseId = supplied;
    } else {
      try {
        airtableBaseId = await provisionClientBase(input.name.trim(), { templateBaseId });
      } catch (err) {
        logger.error("Airtable base provisioning failed", { slug, ...errMeta(err) });
        return {
          ok: false,
          error: `Could not provision the Airtable base: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Create the app-runtime tables the template doesn't carry (idempotent, so
    // it also tops up a manually-supplied base).
    try {
      const rt = await ensureAppRuntimeTables(airtableBaseId);
      if (rt.errors.length) {
        logger.error("App-runtime table setup had errors", { slug, baseId: airtableBaseId, errors: rt.errors });
        return {
          ok: false,
          error: `Could not prepare the base's app tables: ${rt.errors.join("; ")}`,
        };
      }
    } catch (err) {
      logger.error("App-runtime table setup failed", { slug, baseId: airtableBaseId, ...errMeta(err) });
      return {
        ok: false,
        error: `Could not prepare the base's app tables: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Verify the token can read/write RECORDS (data API) — not just schema —
    // before registering the org, so we never create an org whose pages 403.
    try {
      await probeBaseDataAccess(airtableBaseId);
    } catch (err) {
      logger.error("Base is not data-accessible", { slug, baseId: airtableBaseId, ...errMeta(err) });
      return {
        ok: false,
        error:
          `Base ${airtableBaseId} was prepared but the API token cannot read/write its records: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Confirm the token has data.records scope and access to this base, then retry.`,
      };
    }
  }

  const categories = input.budgetCategories.map((c) => c.trim()).filter(Boolean);
  const clientPriorities = input.clientPriorities.map((c) => c.trim()).filter(Boolean);
  const tradeReferences = input.tradeReferences.map((c) => c.trim()).filter(Boolean);
  const rules = input.initialRules.map((r) => r.trim()).filter(Boolean);

  // ── Control plane: org identity lives in the Airtable registry (no Postgres).
  //    Config + seed rules go into the client's own base; nothing touches PG. ──
  if (controlEnabled()) {
    const orgId = await createOrgRegistry({
      slug,
      name: input.name.trim(),
      vertical,
      defaultEngagementType: input.defaultEngagementType,
      allowedEngagementTypes: JSON.stringify(allowed),
      aiAuthority: input.aiAuthority,
      settings,
      airtableBaseId,
    });
    if (input.adminName.trim()) {
      await createControlTeamMember(slug, {
        name: input.adminName.trim(),
        email: input.adminEmail.trim(),
        role: normalizeTeamRole(input.adminRole),
      });
    }
    try {
      await mirrorConfigToBase(slug, categories, rules, clientPriorities, tradeReferences);
      await seedEngagementTypeConfig(slug, allowed, input.defaultEngagementType);
    } catch (err) {
      logger.warn("Airtable config mirror skipped", { slug, ...errMeta(err) });
    }
    // Draft a job-category catalog for a brand-new vertical (no-op for verticals
    // that already have one, e.g. seeded construction/roofing). Best-effort.
    try {
      await ensureJobCatalog(vertical, input.industryLabel ?? vertical, input.subIndustryLabel ?? "");
    } catch (err) {
      logger.warn("Job-catalog draft skipped", { slug, vertical, ...errMeta(err) });
    }
    return { ok: true, orgId, slug };
  }

  // ── Instance Setup — CONTROL database first (org registry + team). No
  // cross-database transaction exists (§2b), so the tenant seeding below runs
  // in its own transaction with a compensating deactivation on failure.
  const org = await controlDb.platOrganisation.create({
    data: {
      slug,
      name: input.name.trim(),
      vertical,
      defaultEngagementType: input.defaultEngagementType,
      allowedEngagementTypes: JSON.stringify(allowed),
      aiAuthority: input.aiAuthority,
      settings,
      airtableBaseId,
    },
  });
  if (input.adminName.trim()) {
    await controlDb.platCtlTeamMember.create({
      data: {
        orgSlug: slug,
        name: input.adminName.trim(),
        role: normalizeTeamRole(input.adminRole),
        email: input.adminEmail.trim(),
      },
    });
  }

  const orgId = await prisma.$transaction(async (tx) => {

    const referenceRows = referenceSeedRows(categories, clientPriorities, tradeReferences);
    if (referenceRows.length) {
      await tx.platCfgReference.createMany({
        data: referenceRows.map((row) => ({
          orgId: org.id,
          type: row.type,
          code: row.code,
          name: row.name,
          value: row.value,
          sortOrder: row.sortOrder,
        })),
      });
    }

    await tx.platCfgSetting.createMany({
      data: SEED_SETTINGS.map((s) => ({ orgId: org.id, key: s.key, value: s.value })),
    });

    // ── Domain Knowledge Initialisation ─────────────────────────────
    let seq = 0;
    for (const description of rules) {
      seq += 1;
      await tx.platLearningRule.create({
        data: {
          orgId: org.id,
          ruleCode: `LRN-${String(seq).padStart(4, "0")}`,
          kind: "guidance",
          description,
          category: "Onboarding",
          confidence: 80, // taught directly by the customer's expert
          isActive: true,
          notes: "Captured during domain knowledge initialisation.",
          dateActivated: new Date(),
        },
      });
    }

    // Spec 12 Module 5 cascade rules (lock decision D-4), mirroring the
    // Airtable-control branch: advisories seed Active, write-effect rules
    // seed as Drafts the owner activates in the learning UI.
    await tx.platLearningRule.createMany({
      data: CASCADE_RULE_SEEDS.map((seed) => ({
        orgId: org.id,
        ruleCode: seed.ruleCode,
        kind: "guidance",
        description: seed.description,
        triggerCondition: seed.triggerCondition,
        confidence: 80,
        isActive: seed.isActive,
        overrideLevel: "owner_only",
        dateActivated: seed.isActive ? new Date() : null,
      })),
    });

    await tx.platExecutionLog.create({
      data: {
        orgId: org.id,
        actorType: "human",
        actorName: input.adminName.trim() || "onboarding",
        operation: "create",
        targetTable: "plat_core_organisation",
        targetId: org.id,
        payload: JSON.stringify({
          slug,
          engagementTypes: allowed,
          aiAuthority: input.aiAuthority,
          initialRules: rules.length,
          budgetCategories: categories.length,
          clientPriorities: clientPriorities.length,
          tradeReferences: tradeReferences.length,
        }),
        status: "executed",
        executedAt: new Date(),
        result: "Organisation provisioned (instance setup + domain knowledge init)",
      },
    });

    return org.id;
  }).catch(async (err: unknown) => {
    // No cross-database transaction exists (§2b): if tenant seeding fails,
    // compensate by removing the control rows so the half-provisioned org
    // never appears in the picker or auth.
    await controlDb.platCtlTeamMember.deleteMany({ where: { orgSlug: slug } }).catch(() => {});
    await controlDb.platOrganisation.delete({ where: { id: org.id } }).catch(() => {});
    throw err;
  });

  // Mirror Customer Config into the org's Airtable base (best effort — the
  // Postgres txn already succeeded, and configSource falls back to Postgres if
  // the base isn't seeded). Seed learning rules are mirrored separately.
  if (airtableEnabled()) {
    try {
      await mirrorConfigToBase(slug, categories, rules, clientPriorities, tradeReferences);
      await seedEngagementTypeConfig(slug, allowed, input.defaultEngagementType);
    } catch (err) {
      logger.warn("Airtable config mirror skipped", { slug, ...errMeta(err) });
    }
  }

  // Draft a job-category catalog for a brand-new vertical (PG control plane;
  // no-op for verticals that already have one). Best-effort, like the
  // Airtable-control branch above.
  try {
    await ensureJobCatalog(vertical, input.industryLabel ?? vertical, input.subIndustryLabel ?? "");
  } catch (err) {
    logger.warn("Job-catalog draft skipped", { slug, vertical, ...errMeta(err) });
  }

  return { ok: true, orgId, slug };
}
