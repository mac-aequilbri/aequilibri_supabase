// AI-drafted job-category catalog for a newly onboarded industry.
//
// When an industry whose vertical has no catalog yet is onboarded, the LLM
// drafts a starter set of job categories (label, group, engagement type, scope
// hint, industry-standard phase sequence) and we seed them into the control
// base's PLAT_JOB_CATALOG. It's a *draft* — an operator can curate it later —
// but it means the New Assessment window is usable for the new vertical
// immediately, with no code change. Curated verticals (construction, roofing)
// are already seeded, so `ensureJobCatalog` no-ops for them.

import { callClaude } from "@/lib/claude";
import { createJobCatalog, hasJobCatalog, type NewJobCatalogEntry } from "@/lib/platform/controlPlane";
import { logger } from "@/lib/logger";

const ENGAGEMENTS = new Set(["short_job", "long_project", "ongoing", "seasonal"]);

const SYSTEM = `You are an operations analyst who designs "job category" catalogs for field-service and project-based businesses (e.g. construction, roofing, solar, electrical, legal, property management).

Given an industry and sub-industry, produce the catalog of job types that business would run assessments/quotes for. Each category needs a realistic, ORDERED phase sequence a practitioner would recognise — the standard stages of delivering that job, grounded in how the trade/profession actually works (and its regulations/standards where relevant).

Return ONLY minified JSON, no prose, no code fences, in exactly this shape:
{"categories":[{"key":"snake_case_id","label":"Human label","group":"Section heading","engagementType":"short_job|long_project|ongoing|seasonal","scopeHint":"One sentence prefilling the scope field.","phases":["Phase 1","Phase 2","..."]}]}

Rules:
- 8 to 14 categories, grouped under 2-5 "group" headings that suit the industry.
- keys are unique lowercase snake_case.
- engagementType is exactly one of: short_job, long_project, ongoing, seasonal.
- phases: 4 to 9 concise, ordered stage names (not paragraphs).
- No commentary — JSON only.`;

/** Ask the model for a catalog draft. Returns [] in demo mode or on parse failure. */
export async function generateJobCatalogDraft(
  verticalKey: string,
  industry: string,
  subIndustry: string,
): Promise<NewJobCatalogEntry[]> {
  const res = await callClaude(
    SYSTEM,
    JSON.stringify({ industry, subIndustry, verticalKey }),
    { maxTokens: 3500 },
  );
  if (res.demo_mode) return []; // no API key — don't seed placeholder junk

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.content.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    logger.warn("Job-catalog draft: unparseable model output", { verticalKey });
    return [];
  }

  const rawList = (parsed as { categories?: unknown })?.categories;
  if (!Array.isArray(rawList)) return [];

  const seen = new Set<string>();
  const out: NewJobCatalogEntry[] = [];
  rawList.forEach((raw, i) => {
    const c = raw as Record<string, unknown>;
    const key = String(c.key ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const label = String(c.label ?? "").trim();
    const phases = Array.isArray(c.phases) ? c.phases.map((p) => String(p).trim()).filter(Boolean) : [];
    if (!key || !label || phases.length === 0 || seen.has(key)) return;
    seen.add(key);
    const engagementType = ENGAGEMENTS.has(String(c.engagementType)) ? String(c.engagementType) : "short_job";
    out.push({
      verticalKey,
      key,
      label,
      group: String(c.group ?? "").trim() || "General",
      engagementType,
      scopeHint: String(c.scopeHint ?? "").trim(),
      phases,
      sortOrder: i,
      source: "ai",
    });
  });
  return out;
}

/** Draft + seed a catalog for a vertical that has none yet. Idempotent (guards
 *  on hasJobCatalog) and best-effort — returns the number of categories written
 *  (0 if it already had a catalog, or generation was unavailable). */
export async function ensureJobCatalog(
  verticalKey: string,
  industry: string,
  subIndustry: string,
): Promise<number> {
  if (!verticalKey || (await hasJobCatalog(verticalKey))) return 0;
  const draft = await generateJobCatalogDraft(verticalKey, industry, subIndustry);
  if (draft.length === 0) return 0;
  await createJobCatalog(draft);
  logger.info("AI-drafted job catalog seeded", { verticalKey, count: draft.length });
  return draft.length;
}
