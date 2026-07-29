// Which project does this text concern?
//
// Inbound correspondence (email, Slack, a form) names its project in prose, not
// by id — "the plasterboard order for Maleny Ridge is due Friday". This module
// turns that prose into a JOBS record via a deterministic ladder, so ingestion
// can raise proposals against the right project instead of declining to route.
//
// The ladder is ordered by how much it can be trusted, and stops at the first
// hit: explicit id → job-name match → sender's project → the org's only job →
// the General bucket. Only the last one is a guess, and it says so
// (`unassigned: true`) so a reviewer can re-target it.
//
// The matching itself (matchJobByName) is pure and covered by unit tests; the
// resolver around it is the only part that touches a backend.

import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import type { RecordId } from "@/lib/platform/recordWriter";
import type { OrgCtx } from "@/lib/platform/types";

/** A project the resolver may match against. `id` is the backend's own id — an
 *  Airtable "rec…" string or a stringified Postgres integer. */
export interface JobCandidate {
  id: string;
  name: string;
}

/** How the project was arrived at. Rendered on the approvals card so a reviewer
 *  can see not just which project, but why. */
export type ResolutionStrategy =
  | "explicit"
  | "name"
  | "sender"
  | "single_job"
  | "general"
  | "none";

export interface JobResolution {
  jobId?: RecordId;
  jobName?: string;
  strategy: ResolutionStrategy;
  /** 0-1. Only ever 1.0 for an explicit id — everything else is inference. */
  confidence: number;
  /** True when nothing in the message identified a project and the record was
   *  parked in General. A reviewer must re-target it before it means anything. */
  unassigned: boolean;
  /** Set when two or more projects matched equally well — the reason the
   *  ladder declined to guess between them. Names only, for the audit note. */
  ambiguousWith?: string[];
}

// ── pure matching ─────────────────────────────────────────────────────────

/** Words that appear in so many project names they cannot distinguish one from
 *  another. A name made only of these has no matchable signal at all. */
const GENERIC_NAME_WORDS = new Set([
  "the", "and", "at", "of", "for", "to",
  "house", "home", "residence", "property", "site", "building",
  "project", "job", "matter", "works", "work", "build", "construction",
  "stage", "unit", "lot", "apartment", "apartments", "development",
  "renovation", "reno", "extension", "addition", "new", "general",
  "street", "st", "road", "rd", "avenue", "ave", "drive", "dr",
  "court", "ct", "place", "pl", "lane", "way", "close", "crescent",
]);

/** A name whose whole identity is generic ("General", "New Project") must never
 *  win a match — it would swallow almost any message. */
const UNMATCHABLE_NAMES = new Set(["general", "unassigned", "misc", "other"]);

/** Confidence floor for a name match to be accepted at all. */
const NAME_MATCH_FLOOR = 0.6;

/** Two candidates scoring within this of each other are treated as ambiguous —
 *  attaching to the wrong project is worse than attaching to none. */
const AMBIGUITY_MARGIN = 0.05;

function norm(v: string): string {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The tokens of a project name that actually identify it. */
function distinctiveTokens(name: string): string[] {
  return norm(name)
    .split(" ")
    .filter((t) => t.length >= 3 && !GENERIC_NAME_WORDS.has(t));
}

export interface NameMatch {
  candidate: JobCandidate;
  confidence: number;
}

export interface NameMatchResult {
  match?: NameMatch;
  /** Populated instead of `match` when the top scorers were too close to call. */
  ambiguous?: JobCandidate[];
}

/** Score every candidate against free text and return the clear winner, or
 *  report ambiguity. Pure — no I/O, no clock, no config.
 *
 *  Two ways to match, strongest first:
 *  1. the whole project name appears in the text ("Maleny Ridge House"), or
 *  2. enough of its distinctive words do ("Maleny Ridge" → Maleny Ridge House).
 *
 *  A name with no distinctive words can only ever match by rule 1. */
export function matchJobByName(candidates: JobCandidate[], text: string): NameMatchResult {
  const haystack = norm(text);
  if (!haystack) return {};
  const words = new Set(haystack.split(" "));
  // Space-padded, so `includes` tests whole words: "Woodlands" must not match
  // inside "Woodlandsville". norm() has already collapsed every separator to a
  // single space, which makes the padding a sufficient word boundary.
  const padded = ` ${haystack} `;

  const scored: NameMatch[] = [];
  for (const candidate of candidates) {
    const normName = norm(candidate.name);
    if (!normName || UNMATCHABLE_NAMES.has(normName)) continue;

    // 1. Whole name present. Longer names beat shorter ones they contain, so
    //    "Maleny Ridge House" wins over a hypothetical "Maleny".
    if (padded.includes(` ${normName} `)) {
      scored.push({ candidate, confidence: Math.min(0.98, 0.9 + normName.length / 500) });
      continue;
    }

    // 2. Distinctive-token overlap.
    const tokens = distinctiveTokens(candidate.name);
    if (tokens.length === 0) continue;
    const hits = tokens.filter((t) => words.has(t)).length;
    if (hits === 0) continue;
    const coverage = hits / tokens.length;
    // A single-token name is matched only in full, and never scores as high as
    // a multi-token name: "Riverside" is far weaker evidence than "Maleny Ridge".
    if (tokens.length === 1) {
      scored.push({ candidate, confidence: 0.7 });
      continue;
    }
    if (coverage < 0.6) continue;
    // Tops out at 0.85, deliberately below the 0.9 floor for a whole-name hit:
    // part of a name is always weaker evidence than all of it.
    scored.push({ candidate, confidence: 0.55 + 0.3 * coverage });
  }

  if (scored.length === 0) return {};
  scored.sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  if (best.confidence < NAME_MATCH_FLOOR) return {};

  const tied = scored.filter((s) => best.confidence - s.confidence <= AMBIGUITY_MARGIN);
  if (tied.length > 1) return { ambiguous: tied.map((t) => t.candidate) };
  return { match: best };
}

// ── backend reads ─────────────────────────────────────────────────────────

/** Ceiling on how many projects one resolution will scan. Orgs with more than
 *  this (the legal demo carries ~3000 matters) are matched against a prefix
 *  only — logged, never silent, because a miss looks identical to "no match". */
const JOB_SCAN_CAP = 1000;

async function loadJobCandidates(ctx: OrgCtx): Promise<JobCandidate[]> {
  if (airtableEnabled(ctx)) {
    const rows = await core.list(ctx.orgSlug, "JOBS", { maxRecords: JOB_SCAN_CAP });
    if (rows.length >= JOB_SCAN_CAP) {
      logger.warn("Job resolution scanned a truncated project list", {
        orgSlug: ctx.orgSlug,
        cap: JOB_SCAN_CAP,
      });
    }
    return rows.map((r) => ({
      id: r.id,
      name: typeof r["Job_Name"] === "string" ? r["Job_Name"] : "",
    }));
  }
  const rows = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId },
    orderBy: { id: "asc" },
    take: JOB_SCAN_CAP,
    select: { id: true, name: true, code: true },
  });
  // A Postgres job carries a short code ("MRH-01") as well as a name; both are
  // things a person writes in an email, so both are matchable.
  return rows.flatMap((r) => {
    const out: JobCandidate[] = [{ id: String(r.id), name: r.name }];
    if (r.code && norm(r.code) !== norm(r.name)) out.push({ id: String(r.id), name: r.code });
    return out;
  });
}

/** The project a known sender implies. Postgres only: PlatJob.clientContactId
 *  links a job to a contact, so an email from that contact points at the job.
 *  The canonical Airtable schema has no CONTACTS↔JOBS link in either direction
 *  (CONTACTS links to ORGANISATIONS, JOBS to TEAM), so this rung is skipped
 *  there rather than faked. */
async function jobFromSender(ctx: OrgCtx, sender: string): Promise<JobCandidate | null> {
  const email = sender.match(/[^\s<>"]+@[^\s<>"]+/)?.[0]?.toLowerCase();
  if (!email || airtableEnabled(ctx)) return null;

  const contact = await db(ctx).platContact.findFirst({
    where: { orgId: ctx.orgId, email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (!contact) return null;

  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId, clientContactId: contact.id },
    take: 2,
    select: { id: true, name: true },
  });
  // Only when the contact points at exactly one project — a client with three
  // jobs tells us nothing about which one this email is about.
  return jobs.length === 1 ? { id: String(jobs[0].id), name: jobs[0].name } : null;
}

/** The org's General project — the shared bucket that every member can see.
 *  Set at provisioning (config.generalJobId); falls back to a name lookup for
 *  orgs provisioned before that, and for Postgres orgs which have no rec id. */
function findGeneralJob(ctx: OrgCtx, candidates: JobCandidate[]): JobCandidate | null {
  // config is optional-chained: callers deep in the ingestion path build a ctx
  // from a webhook payload, and it isn't guaranteed to carry org settings.
  const configured = ctx.config?.generalJobId;
  if (configured) {
    const hit = candidates.find((c) => c.id === configured);
    if (hit) return hit;
    return { id: configured, name: "General" };
  }
  return candidates.find((c) => norm(c.name) === "general") ?? null;
}

/** An Airtable id stays a string; a Postgres id goes back to a number, because
 *  that is what the write schemas and the pending-write Int column expect. */
function toRecordId(id: string): RecordId {
  return /^\d+$/.test(id) ? Number(id) : id;
}

export interface ResolveJobInput {
  subject?: string;
  body?: string;
  sender?: string;
  /** An id supplied by the caller (the hooks route accepts one) — trusted. */
  explicitJobId?: RecordId;
}

/** Work out which project a message concerns. Never throws: a backend that
 *  can't be read yields an unresolved result, and ingestion continues without
 *  routing rather than losing the message. */
export async function resolveJobFromText(
  ctx: OrgCtx,
  input: ResolveJobInput,
): Promise<JobResolution> {
  if (input.explicitJobId != null && input.explicitJobId !== "") {
    return { jobId: input.explicitJobId, strategy: "explicit", confidence: 1, unassigned: false };
  }

  let candidates: JobCandidate[];
  try {
    candidates = await loadJobCandidates(ctx);
  } catch (err) {
    logger.warn("Job resolution could not list projects", {
      orgSlug: ctx.orgSlug,
      error: err instanceof Error ? err.message : String(err),
    });
    return { strategy: "none", confidence: 0, unassigned: true };
  }

  const text = [input.subject ?? "", input.body ?? ""].filter(Boolean).join("\n");
  const byName = matchJobByName(candidates, text);
  if (byName.match) {
    return {
      jobId: toRecordId(byName.match.candidate.id),
      jobName: byName.match.candidate.name,
      strategy: "name",
      confidence: byName.match.confidence,
      unassigned: false,
    };
  }

  // Ambiguity is a real answer, not a failure — but it is not a project. Carry
  // the tie into the General fallback so the reviewer sees the shortlist.
  const ambiguousWith = byName.ambiguous?.map((c) => c.name);

  if (!ambiguousWith && input.sender) {
    const bySender = await jobFromSender(ctx, input.sender).catch(() => null);
    if (bySender) {
      return {
        jobId: toRecordId(bySender.id),
        jobName: bySender.name,
        strategy: "sender",
        confidence: 0.65,
        unassigned: false,
      };
    }
  }

  // An org with exactly one real project can only mean that one. General is not
  // a real project, so it doesn't count towards the total.
  const real = candidates.filter((c) => !UNMATCHABLE_NAMES.has(norm(c.name)));
  const uniqueIds = new Set(real.map((c) => c.id));
  if (uniqueIds.size === 1) {
    const only = real[0];
    return {
      jobId: toRecordId(only.id),
      jobName: only.name,
      strategy: "single_job",
      confidence: 0.6,
      unassigned: false,
      ambiguousWith,
    };
  }

  const general = findGeneralJob(ctx, candidates);
  if (general) {
    return {
      jobId: toRecordId(general.id),
      jobName: general.name,
      strategy: "general",
      confidence: 0,
      unassigned: true,
      ambiguousWith,
    };
  }
  return { strategy: "none", confidence: 0, unassigned: true, ambiguousWith };
}
