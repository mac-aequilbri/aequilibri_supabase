// Governance Phase 4 — the DOMAIN_LABELS read layer (§4). One record per Core
// field per Domain renders vertical-specific field labels, so onboarding a new
// vertical means adding records, never a column. Every miss falls back to the
// hardcoded label.

import { airtableMapFor } from "@/lib/airtable/fieldMaps";
import type { RecordEditorConfig } from "./recordEditor";
import type { OrgCtx } from "./types";

export interface DomainLabel {
  label: string;
  contextNote: string;
}

/** Active labels for the org's vertical, keyed `${Core_Table}.${Core_Field_Label}`.
 *  DOMAIN_LABELS has no Postgres source, so this is always empty — every
 *  caller falls back to its hardcoded label. */
export async function getDomainLabels(_ctx: OrgCtx): Promise<Map<string, DomainLabel>> {
  return new Map();
}

/** Overlay domain labels onto a RecordEditorConfig: each field's app key is
 *  translated to its Airtable Core field via the write field map, and a
 *  matching DOMAIN_LABELS row replaces the label (Context_Note becomes help
 *  text when the field has none). Returns the config unchanged when there are
 *  no labels — the common case until D8 populates the table. */
export async function localizeEditorConfig(
  ctx: OrgCtx,
  config: RecordEditorConfig,
): Promise<RecordEditorConfig> {
  return applyDomainLabels(config, await getDomainLabels(ctx));
}

/** Pure overlay half of localizeEditorConfig (unit-testable). */
export function applyDomainLabels(
  config: RecordEditorConfig,
  labels: ReadonlyMap<string, DomainLabel>,
): RecordEditorConfig {
  if (!labels.size) return config;
  const map = airtableMapFor(config.table);
  if (!map) return config;
  const airName = (appKey: string): string | undefined =>
    map.specs.find((s) => s.from === appKey)?.air;
  return {
    ...config,
    fields: config.fields.map((f) => {
      const air = airName(f.name);
      const hit = air ? labels.get(`${map.table}.${air}`) : undefined;
      if (!hit) return f;
      return { ...f, label: hit.label, help: f.help ?? (hit.contextNote || undefined) };
    }),
  };
}

/** Domain label for one app-key field of a writable table ("budgetAmount" on
 *  "budget_line" → "Cost Line" when a BUDGET.Estimated row exists). Returns
 *  undefined when no override applies — callers keep their hardcoded label. */
export function labelForAppField(
  labels: ReadonlyMap<string, DomainLabel>,
  tableKey: string,
  appKey: string,
): string | undefined {
  if (!labels.size) return undefined;
  const map = airtableMapFor(tableKey);
  const air = map?.specs.find((s) => s.from === appKey)?.air;
  return air ? labels.get(`${map!.table}.${air}`)?.label : undefined;
}

/** Domain label for a whole table, by convention a DOMAIN_LABELS row with
 *  Core_Field_Label "_TABLE" (e.g. "ISSUES._TABLE" → "Matter tasks"). Falls
 *  back to undefined — callers keep friendlyTableLabel. */
export function tableLabelFor(
  labels: ReadonlyMap<string, DomainLabel>,
  tableKey: string,
): string | undefined {
  if (!labels.size) return undefined;
  const air = airtableMapFor(tableKey)?.table;
  return air ? labels.get(`${air}._TABLE`)?.label : undefined;
}

/** Assistant-prompt vocabulary block (Spec 12 Module 7: confirmation cards and
 *  assistant language use the org's domain terminology). "" when the org has
 *  no labels — the common case until D8 population. Capped to keep the prompt
 *  bounded. */
export async function domainVocabBlock(ctx: OrgCtx): Promise<string> {
  const labels = await getDomainLabels(ctx);
  if (!labels.size) return "";
  const lines = [...labels.entries()]
    .slice(0, 30)
    .map(([key, l]) => `${key.replace("._TABLE", " (table)")} is called "${l.label}"${l.contextNote ? ` — ${l.contextNote}` : ""}`);
  return `DOMAIN TERMINOLOGY (use these names with the user):\n- ${lines.join("\n- ")}`;
}

/** Invalidate after DOMAIN_LABELS writes (onboarding, admin edits). No-op —
 *  there is no cache now that the labels read is a constant empty map. */
export function invalidateDomainLabels(_orgSlug: string): void {}
