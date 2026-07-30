// Customer Onboarding Engine (module 1) — provisions a configured,
// ready-to-learn customer instance in one transaction. Covers both
// sub-processes from the architecture doc:
//   Instance Setup: org row (the "clone" — Core schema is shared, so a new
//     instance is configuration, not new tables), customer-config defaults,
//     first admin.
//   Domain Knowledge Initialisation: the customer's rules of thumb encoded
//     as guidance learning rules before any jobs run, so the assistant
//     starts with something to work from.

import { getOrgRegistry } from "@/lib/platform/controlPlane";
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

  const categories = input.budgetCategories.map((c) => c.trim()).filter(Boolean);
  const clientPriorities = input.clientPriorities.map((c) => c.trim()).filter(Boolean);
  const tradeReferences = input.tradeReferences.map((c) => c.trim()).filter(Boolean);
  const rules = input.initialRules.map((r) => r.trim()).filter(Boolean);

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
