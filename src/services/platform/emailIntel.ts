// Email → operational intent.
//
// The regex rules in inferRouteSuggestions can only spot four keyword shapes,
// and only once a job id is already known. This replaces them for inbound
// messages with an extraction pass over the whole text, across the full routing
// vocabulary — following processMeetingMinutes exactly: strict-JSON prompt,
// defensive parse, per-field clamping, nothing trusted.
//
// It returns RouteSuggestion[], so routeOperationalWrites and the whole
// approval path downstream are untouched. Every suggestion is still a proposal;
// nothing here writes.

import { callClaude } from "@/lib/claude";
import { logger } from "@/lib/logger";
import {
  inferRouteSuggestions,
  isRouteTable,
  type RouteSuggestion,
  type RouteTable,
} from "@/lib/platform/ingestion";
import { modelFor } from "@/lib/platform/modelRouter";
import { getPrompt } from "@/lib/platform/prompts";
import type { RecordId } from "@/lib/platform/recordWriter";
import type { OrgCtx } from "@/lib/platform/types";

/** Below this, an intent is dropped rather than shown to a reviewer. The model
 *  is told to score vagueness under 0.5, so this keeps the clearly-speculative
 *  out of the queue while leaving genuine uncertainty visible and reviewable. */
const MIN_CONFIDENCE = 0.4;

/** Cap on intents from one message — a runaway parse can't flood the queue. */
const MAX_INTENTS = 12;

/** Matches the input clamp used for meeting minutes. */
const MAX_INPUT_CHARS = 12_000;

const str = (v: unknown, max: number): string =>
  v == null ? "" : String(v).replace(/\s+/g, " ").trim().slice(0, max);

const num = (v: unknown): number | undefined => {
  if (v == null || v === "") return undefined;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
};

const intIn = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = num(v);
  if (n == null) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** An ISO date, or undefined — never a half-parsed string the writer would
 *  reject. Anything that isn't a real calendar date is dropped. */
const date = (v: unknown): string | undefined => {
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  return Number.isNaN(new Date(s).getTime()) ? undefined : s;
};

const period = (v: unknown, fallback: string): string => {
  const s = str(v, 7);
  return /^\d{4}-\d{2}$/.test(s) ? s : fallback;
};

/** Drop keys the caller left undefined, so the write schemas apply their own
 *  defaults instead of validating an explicit undefined. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== ""));
}

const ONE_OF = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => {
  const s = str(v, 40);
  return (allowed as readonly string[]).includes(s) ? (s as T) : dflt;
};

interface RawIntent {
  table: RouteTable;
  summary: string;
  evidence: string;
  confidence: number;
  fields: Record<string, unknown>;
}

/** Turn one validated intent into the payload its table's writer expects. The
 *  field names here are the write-registry (zod) keys, NOT Airtable names —
 *  the field maps do that translation. */
function payloadFor(
  intent: RawIntent,
  jobId: RecordId | undefined,
  sender: string,
  todayPeriod: string,
): Record<string, unknown> | null {
  const f = intent.fields;
  const base = { jobId };

  switch (intent.table) {
    case "action":
      if (!str(f.title, 300)) return null;
      return compact({
        ...base,
        title: str(f.title, 300),
        detail: str(f.detail, 2000),
        owner: str(f.owner, 200),
        dueDate: date(f.dueDate),
        priority: ONE_OF(f.priority, ["P1", "P2", "P3"] as const, "P2"),
        status: "open",
      });

    case "decision":
      if (!str(f.description, 2000)) return null;
      return compact({
        ...base,
        description: str(f.description, 2000),
        rationale: str(f.rationale, 2000),
        madeBy: str(f.madeBy, 200) || sender,
        decidedAt: date(f.decidedAt),
        category: "inbound_email",
        status: "proposed",
      });

    case "risk":
      if (!str(f.description, 2000)) return null;
      return compact({
        ...base,
        description: str(f.description, 2000),
        likelihood: intIn(f.likelihood, 1, 5, 3),
        impact: intIn(f.impact, 1, 5, 3),
        mitigation: str(f.mitigation, 2000),
        owner: str(f.owner, 200),
        status: "open",
        createdByAi: true,
      });

    case "variation_order":
      if (!str(f.title, 300)) return null;
      return compact({
        ...base,
        title: str(f.title, 300),
        description: str(f.description, 2000),
        scopeChange: str(f.scopeChange, 2000),
        costImpact: num(f.costImpact) ?? 0,
        timeImpactDays: Math.round(num(f.timeImpactDays) ?? 0),
        status: "draft",
        isAiDrafted: true,
        submittedBy: sender,
      });

    case "procurement": {
      if (!str(f.item, 300)) return null;
      const qty = num(f.qty) ?? 1;
      const unitPrice = num(f.unitPrice) ?? 0;
      return compact({
        ...base,
        item: str(f.item, 300),
        qty,
        unitPrice,
        total: qty * unitPrice,
        vendorName: str(f.vendorName, 200) || sender,
        dueDate: date(f.dueDate),
        status: "pending",
      });
    }

    case "cashflow": {
      const amount = num(f.amount);
      // A ledger line with no amount is not a ledger line.
      if (amount == null || amount <= 0) return null;
      return compact({
        ...base,
        name: str(f.name, 200) || intent.summary.slice(0, 200),
        amount,
        type: ONE_OF(f.type, ["In", "Out"] as const, "Out"),
        period: period(f.period, todayPeriod),
        sourceOrPayee: str(f.sourceOrPayee, 200) || sender,
        category: str(f.category, 100),
        // Never "Paid"/"Confirmed" off an email — a human confirms money.
        status: "Forecast",
      });
    }

    case "comms":
      if (!str(f.topic, 300)) return null;
      return compact({
        ...base,
        topic: str(f.topic, 300),
        messageType: ONE_OF(
          f.messageType,
          ["Decision Notification", "Status Update", "Action Required", "Approval Request", "Escalation"] as const,
          "Status Update",
        ),
        stakeholderRole: ONE_OF(
          f.stakeholderRole,
          ["Owner", "Builder", "Architect", "Broker", "Supplier", "Regulatory", "Other"] as const,
          "Other",
        ),
        dueDate: date(f.dueDate),
        notes: str(f.notes, 2000),
        status: "pending",
      });

    case "plan":
      if (!str(f.name, 300)) return null;
      return compact({
        ...base,
        name: str(f.name, 300),
        startDate: date(f.startDate),
        endDate: date(f.endDate),
        durationDays: num(f.durationDays) == null ? undefined : Math.max(0, Math.round(num(f.durationDays) as number)),
        notes: str(f.notes, 2000),
        status: "Not Started",
      });
  }
}

/** Parse the model's reply into intents. Never throws: a malformed reply is no
 *  intents, which degrades to filing the email as correspondence. */
function parseIntents(content: string): RawIntent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    return [];
  }
  const raw = (parsed as { intents?: unknown })?.intents;
  if (!Array.isArray(raw)) return [];

  const out: RawIntent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (!isRouteTable(o.table)) continue;
    const confidence = num(o.confidence);
    out.push({
      table: o.table,
      summary: str(o.summary, 300),
      evidence: str(o.evidence, 500),
      // An intent that forgot to score itself is treated as merely plausible,
      // not as certain — it still has to clear MIN_CONFIDENCE.
      confidence: confidence == null ? 0.5 : Math.min(1, Math.max(0, confidence)),
      fields: (o.fields && typeof o.fields === "object" ? o.fields : {}) as Record<string, unknown>,
    });
  }
  return out;
}

export interface ExtractEmailInput {
  subject?: string;
  body?: string;
  sender?: string;
  jobId?: RecordId;
  jobName?: string;
  /** ISO date the message arrived, for resolving "Friday". Defaults to today. */
  receivedAt?: string;
  /** Passed to the regex fallback so its behaviour is unchanged. */
  docDate: string;
  sourceDocumentId?: RecordId;
}

/** Extract operational intent from one inbound message.
 *
 *  Falls back to the deterministic regex rules whenever the AI is unavailable
 *  (no ANTHROPIC_API_KEY → demo_mode), so the path degrades instead of
 *  breaking, and tests stay hermetic without mocking the network. */
export async function extractEmailIntents(
  ctx: OrgCtx,
  input: ExtractEmailInput,
): Promise<RouteSuggestion[]> {
  const subject = input.subject ?? "";
  const body = input.body ?? "";
  const sender = input.sender ?? "";
  const text = [subject, body].filter(Boolean).join("\n\n");

  const fallback = (): RouteSuggestion[] =>
    inferRouteSuggestions({
      classification: "correspondence",
      text,
      title: subject,
      sender,
      docDate: input.docDate,
      jobId: input.jobId,
      sourceDocumentId: input.sourceDocumentId,
    });

  if (!text.trim()) return [];

  const today = (input.receivedAt || input.docDate || "").slice(0, 10) || new Date().toISOString().slice(0, 10);
  const { system } = getPrompt("email.extract", {
    jobName: input.jobName || "this project",
    today,
  });
  const user = [`From: ${sender}`, `Subject: ${subject}`, "", body].join("\n").slice(0, MAX_INPUT_CHARS);

  const res = await callClaude(system, user, {
    model: modelFor("extraction"),
    maxTokens: 2000,
  });
  if (res.demo_mode) return fallback();

  const todayPeriod = today.slice(0, 7);
  const suggestions: RouteSuggestion[] = [];
  for (const intent of parseIntents(res.content)) {
    if (suggestions.length >= MAX_INTENTS) break;
    if (intent.confidence < MIN_CONFIDENCE) continue;

    const payload = payloadFor(intent, input.jobId, sender, todayPeriod);
    if (!payload) continue;
    suggestions.push({
      table: intent.table,
      summary: intent.summary || `Captured ${intent.table} from inbound email.`,
      payload,
      evidence: intent.evidence,
      confidence: intent.confidence,
    });
  }

  // A reply that parsed to nothing usable — as opposed to an email with
  // genuinely no operational content — is worth knowing about.
  if (suggestions.length === 0 && res.content.trim() && !res.content.includes('"intents": []')) {
    logger.info("Email extraction produced no routable intents", {
      orgSlug: ctx.orgSlug,
      subject: subject.slice(0, 120),
    });
  }
  return suggestions;
}
