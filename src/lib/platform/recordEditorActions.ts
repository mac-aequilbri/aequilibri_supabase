"use server";

// Generic, table-agnostic server actions behind the shared <RecordEditor>. These
// generalise updateActionDetail / suggestActionEdits (actions/[id]) so every
// list window can offer the same edit + AI-assist experience without a bespoke
// copy. Both go through the existing write/validation stack — writeRecord
// validates, typecasts, stamps orgId, and audits — so no new write path exists.

import { revalidatePath } from "next/cache";
import { callClaude } from "@/lib/claude";
import { getCurrentUser, requireOrgCtx } from "./org-context";
import { orgPath } from "./paths";
import type { AiFieldLite, EditorFieldType, FieldSpecLite } from "./recordEditor";
import { isWritableTable, writeRecord, type WritableTable } from "./recordWriter";

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Coerce one submitted value to its field type, applying the same clear
 *  semantics as updateActionDetail: a blank text stays "" and a blank date is
 *  left untouched. Returns a sentinel `SKIP` for values that should not be
 *  sent at all. */
const SKIP = Symbol("skip");
function coerce(type: EditorFieldType, raw: string): unknown | typeof SKIP {
  switch (type) {
    case "number": {
      const t = raw.trim();
      if (t === "") return SKIP; // don't clobber a numeric field with a blank
      const n = Number(t);
      return Number.isFinite(n) ? n : SKIP;
    }
    case "checkbox":
      return raw === "true" || raw === "on" || raw === "1";
    case "date":
      return raw.trim() === "" ? SKIP : raw.trim();
    default:
      // text / textarea / select
      return raw;
  }
}

/** Result of a Save from the shared editor, surfaced back via useActionState so
 *  a failed write is visible and the client controls navigation (a redirect
 *  here would route through the [org] loading fallback and blank the editor). */
export interface UpdateRecordResult {
  ok: boolean;
  error?: string;
}

/** Save edits to a single record. Field metadata rides in the hidden `__spec`
 *  input so this one action serves every table. */
export async function updateRecordDetail(
  _prev: UpdateRecordResult | null,
  formData: FormData,
): Promise<UpdateRecordResult> {
  const ctx = await requireOrgCtx(str(formData.get("org")));
  const user = await getCurrentUser(ctx); // enforces the write gate

  const table = str(formData.get("table"));
  const recordId = str(formData.get("recordId"));
  const listPath = str(formData.get("listPath")) || "";
  if (!isWritableTable(table) || !recordId) {
    return { ok: false, error: "Missing record reference." };
  }

  let spec: FieldSpecLite[] = [];
  try {
    spec = JSON.parse(str(formData.get("__spec")) || "[]") as FieldSpecLite[];
  } catch {
    return { ok: false, error: "The form spec could not be read — reload and try again." };
  }

  const data: Record<string, unknown> = {};
  for (const f of spec) {
    if (f.readOnly) continue;
    // A checkbox that's unchecked posts nothing — treat absence as "false".
    const present = formData.has(f.name);
    const raw = f.type === "checkbox" ? (present ? "true" : "false") : str(formData.get(f.name));
    const value = coerce(f.type, raw);
    if (value !== SKIP) data[f.name] = value;
  }

  try {
    await writeRecord(ctx, {
      table: table as WritableTable,
      op: "update",
      recordId,
      data,
      actor: { type: "human", name: user.name },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The change could not be saved." };
  }

  if (listPath) revalidatePath(orgPath(ctx.orgSlug, listPath));
  return { ok: true };
}

// ── AI assist ───────────────────────────────────────────────────────────────

export interface SuggestResult {
  ok: boolean;
  demo?: boolean;
  error?: string;
  note?: string;
  /** Suggested values keyed by field name. */
  suggestion?: Record<string, string | number | boolean>;
}

function buildSystemPrompt(role: string, fields: AiFieldLite[]): string {
  const lines = fields.map((f) => {
    const opts = f.options?.length ? ` (one of: ${f.options.map((o) => o.value).join(", ")})` : "";
    const kind = f.type === "number" ? "number" : f.type === "date" ? "YYYY-MM-DD" : "text";
    return `- ${f.name}: ${f.label} — ${kind}${opts}`;
  });
  return `${role}

Given the record's current fields, propose improved values: fill in anything missing or vague and tighten the wording. Do NOT invent facts you can't infer (names, dates, figures) — leave those blank instead.

Return ONLY minified JSON, no prose, no code fences, with any subset of these keys:
${lines.join("\n")}
- note: one short sentence on what you changed

Rules:
- Only include a key when you have a real basis to suggest it; omit the rest.
- Match the stated type/options exactly.
- JSON only.`;
}

/** AI-assist for the shared editor. Returns suggested field values for the user
 *  to review before saving — nothing is written here. Signature matches
 *  useActionState. Field descriptors ride in the hidden `__aifields` input. */
export async function suggestRecordEdits(
  _prev: SuggestResult | null,
  formData: FormData,
): Promise<SuggestResult> {
  const ctx = await requireOrgCtx(str(formData.get("org")));
  await getCurrentUser(ctx); // gate on an authorised user

  const role = str(formData.get("aiRole")) || "You are an operations assistant helping tidy up a record.";
  let fields: AiFieldLite[] = [];
  try {
    fields = JSON.parse(str(formData.get("__aifields")) || "[]") as AiFieldLite[];
  } catch {
    fields = [];
  }
  if (fields.length === 0) {
    return { ok: false, error: "Nothing to auto-fill on this record." };
  }

  const current: Record<string, string> = {};
  for (const f of fields) current[f.name] = str(formData.get(f.name));

  const res = await callClaude(buildSystemPrompt(role, fields), JSON.stringify(current), {
    maxTokens: 900,
  });
  if (res.demo_mode) {
    return { ok: true, demo: true, note: "Demo mode — set ANTHROPIC_API_KEY to get real suggestions." };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(res.content.replace(/^```(json)?|```$/g, "").trim());
  } catch {
    return { ok: false, error: "The assistant returned something unexpected. Try again." };
  }

  const suggestion: Record<string, string | number | boolean> = {};
  for (const f of fields) {
    if (!(f.name in parsed)) continue;
    const v = parsed[f.name];
    if (f.type === "number") {
      const n = Number(v);
      if (Number.isFinite(n)) suggestion[f.name] = n;
    } else if (f.type === "date") {
      const s = str(v);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) suggestion[f.name] = s;
    } else if (f.type === "select") {
      const s = str(v);
      if (f.options?.some((o) => o.value === s)) suggestion[f.name] = s;
    } else {
      const s = str(v).trim();
      if (s) suggestion[f.name] = s;
    }
  }

  return {
    ok: true,
    note: str(parsed.note).trim() || "Suggested edits ready — review and save.",
    suggestion,
  };
}
