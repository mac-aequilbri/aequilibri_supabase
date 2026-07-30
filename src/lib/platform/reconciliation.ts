// Post-write reconciliation — Spec 12 Module 2 (confirmed in scope 30 Jun
// 2026). A separate mechanism from pre-write human review: pre-write review
// catches bad extraction before the write; this catches cases where the
// correct value was proposed, reviewed, and submitted, but something dropped
// between submission and storage. After write confirmation from the Airtable
// API, each written record is re-read and its stored values compared against
// the submitted values field by field. A mismatch is never silently accepted:
// it is logged as a CORRECTIONS record with Root_Cause = Data Quality (naming
// the field, submitted value, and stored value) and surfaced to the owner as
// an open ISSUES exception.
//
// Postgres writes re-read through the same validated Prisma layer that wrote
// them, so reconciliation only ever applied to the Airtable (system-of-record)
// path — with that backend decommissioned, reconcileAirtableWrite is a no-op.

import type { Actor, OrgCtx } from "@/lib/platform/types";

export interface FieldMismatch {
  field: string;
  submitted: string;
  stored: string;
}

const str = (v: unknown): string => (v == null ? "" : String(v));

/** Tolerant equivalence between a value submitted to Airtable and the value
 *  read back. Airtable typecasts on write ("5" → 5) and omits falsy fields
 *  (false checkbox, empty string) from reads, so exact equality would flag
 *  storage conventions as mismatches. Only genuine divergence returns false. */
export function valuesEquivalent(sent: unknown, stored: unknown): boolean {
  // Absent-on-read equals any "empty" submission (null/""/false/empty array).
  if (stored === undefined || stored === null) {
    return (
      sent === undefined ||
      sent === null ||
      sent === "" ||
      sent === false ||
      (Array.isArray(sent) && sent.length === 0)
    );
  }
  if (Array.isArray(sent) || Array.isArray(stored)) {
    const a = Array.isArray(sent) ? sent.map(str) : [str(sent)];
    const b = Array.isArray(stored) ? stored.map(str) : [str(stored)];
    return a.length === b.length && a.every((v) => b.includes(v));
  }
  // Numeric equivalence covers typecast ("5" vs 5, "5.0" vs 5).
  const an = Number(sent);
  const bn = Number(stored);
  if (str(sent).trim() !== "" && Number.isFinite(an) && Number.isFinite(bn)) return an === bn;
  return str(sent).trim() === str(stored).trim();
}

/** Field-by-field diff of the submitted Airtable payload against the stored
 *  record. Only submitted fields are compared — formulas, rollups, and fields
 *  the write never touched cannot be write drift. */
export function diffStoredVsSubmitted(
  sent: Record<string, unknown>,
  stored: Record<string, unknown>,
): FieldMismatch[] {
  const out: FieldMismatch[] = [];
  for (const [field, submitted] of Object.entries(sent)) {
    if (submitted === undefined) continue; // never sent
    if (!valuesEquivalent(submitted, stored[field])) {
      out.push({ field, submitted: str(submitted), stored: str(stored[field]) });
    }
  }
  return out;
}

