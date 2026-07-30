// Learned phase templates — the "known learnings" for project structure.
// A new job's phases should follow how this customer has actually structured
// past jobs of the same engagement type, not be re-invented by the AI each
// time. We derive a template from prior jobs' (human-approved) phases; the
// assessment engine treats it as the primary plan when one exists.
//
// The loop closes structurally: refined phases become an accepted job's
// phases, which the next derivation reads — so learnings improve without any
// extra bookkeeping.

import { db, prisma } from "@/lib/db";
import { OrgCtx } from "@/lib/platform/types";

export interface PhaseTemplate {
  /** Phase names in their learned order. */
  phases: { name: string }[];
  /** How many prior jobs of this engagement type contributed. */
  sampleCount: number;
  /** A few example job codes the template was learned from (for provenance). */
  sourceJobCodes: string[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Build a phase template from this org's prior jobs. Prior jobs of the same
 *  job CATEGORY take priority (most specific learning); failing that, jobs of
 *  the same engagement type. Returns null when there's no history to learn
 *  from. */
export async function derivePhaseTemplate(
  ctx: OrgCtx,
  opts: { engagementType: string; category?: string },
): Promise<PhaseTemplate | null> {
  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId, engagementType: opts.engagementType },
    orderBy: { createdAt: "desc" },
    include: {
      conPhases: {
        where: { isAiDraft: false },
        orderBy: { sortOrder: "asc" },
        select: { name: true },
      },
    },
  });
  let withPhases = jobs.filter((j) => j.conPhases.length > 0);

  // When a category is given, learn ONLY from prior jobs of that same category
  // (stored on PlatJob.meta at acceptance) — a same-engagement job of a
  // different category is no guide (a deck rebuild can't shape a solar plan).
  // With no same-category history we return null so the industry catalog
  // default takes over. Without a category we keep the broader
  // same-engagement-type behaviour.
  if (opts.category) {
    withPhases = withPhases.filter((j) => {
      try {
        return (JSON.parse(j.meta || "{}") as { category?: string }).category === opts.category;
      } catch {
        return false;
      }
    });
  }
  if (withPhases.length === 0) return null;

  // Thin history: reuse the most recent similar job's coherent sequence rather
  // than blending dissimilar plans into a Frankenstein template. (jobs are
  // ordered newest-first, so withPhases[0] is the most recent.)
  if (withPhases.length < 3) {
    const recent = withPhases[0];
    const seen = new Set<string>();
    const phases: { name: string }[] = [];
    for (const p of recent.conPhases) {
      const key = norm(p.name);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      phases.push({ name: p.name });
    }
    return {
      phases,
      sampleCount: withPhases.length,
      sourceJobCodes: [recent.code],
    };
  }

  // Enough history: keep phases common to a majority of prior jobs, ordered by
  // their average position in the sequence.
  const stats = new Map<string, { display: string; jobs: number; posSum: number }>();
  for (const job of withPhases) {
    const seen = new Set<string>();
    job.conPhases.forEach((p, idx) => {
      const key = norm(p.name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      const s = stats.get(key) ?? { display: p.name, jobs: 0, posSum: 0 };
      s.jobs += 1;
      s.posSum += idx;
      stats.set(key, s);
    });
  }
  const threshold = Math.ceil(withPhases.length / 2);
  const kept = [...stats.values()]
    .filter((s) => s.jobs >= threshold)
    .sort((a, b) => a.posSum / a.jobs - b.posSum / b.jobs);
  if (kept.length === 0) return null;

  return {
    phases: kept.map((s) => ({ name: s.display })),
    sampleCount: withPhases.length,
    sourceJobCodes: withPhases.map((j) => j.code).slice(0, 5),
  };
}

export interface PhaseInput {
  name: string;
  weeks: number;
}

/** Merge a learned phase structure (primary) with AI-suggested week durations
 *  (secondary). Names/order come from the template; weeks come from a matching
 *  AI phase, with any gaps filled by distributing the remaining duration. */
export function applyTemplateWeeks(
  template: PhaseTemplate,
  aiPhases: PhaseInput[],
  totalWeeks: number,
): PhaseInput[] {
  const aiByName = new Map(aiPhases.map((p) => [norm(p.name), Math.max(0, Math.round(p.weeks) || 0)]));
  const phases = template.phases.map((p) => ({ name: p.name, weeks: aiByName.get(norm(p.name)) ?? 0 }));

  const zeros = phases.filter((p) => p.weeks === 0);
  if (zeros.length) {
    const assigned = phases.reduce((s, p) => s + p.weeks, 0);
    const remaining = Math.max(zeros.length, (totalWeeks || 0) - assigned);
    const per = Math.max(1, Math.round(remaining / zeros.length));
    for (const p of phases) if (p.weeks === 0) p.weeks = per;
  }
  return phases;
}
