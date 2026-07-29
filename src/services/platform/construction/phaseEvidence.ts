// Phase evidence review — site photos/documents attached to a phase, and an
// AI assessment that SUGGESTS a completion percentage from them. The
// suggestion is an annotation on the phase (evidenceSuggestion JSON), never a
// direct write to completionPct: a human approves, adjusts, or dismisses it,
// and adjustments/dismissals emit corrections into the learning loop.

import { callClaude, callClaudeVisionMulti, VisionImage } from "@/lib/claude";
import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { emitCorrection } from "@/lib/platform/corrections";
import { modelFor } from "@/lib/platform/modelRouter";
import { getPrompt } from "@/lib/platform/prompts";
import { type RecordId, writeRecord } from "@/lib/platform/recordWriter";
import { getStorerFor } from "@/lib/platform/storage";
import { OrgCtx } from "@/lib/platform/types";
import { ingestDocumentFile } from "@/services/platform/documents";

export interface EvidenceSuggestion {
  suggestedPct: number;
  confidence: number;
  observations: string[];
  missingEvidence: string[];
  rationale: string;
  evidenceCount: number;
  imageCount: number;
  demoMode: boolean;
  suggestedAt: string;
}

const VISION_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4_500_000; // Anthropic per-image ceiling, with headroom

const clampPct = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export function parseSuggestion(json: string): EvidenceSuggestion | null {
  try {
    const s = JSON.parse(json);
    if (!s || typeof s.suggestedPct !== "number") return null;
    return s as EvidenceSuggestion;
  } catch {
    return null;
  }
}

async function getPhase(ctx: OrgCtx, phaseId: RecordId) {
  if (airtableEnabled(ctx)) {
    const phaseRecId = String(phaseId);
    if (!phaseRecId.startsWith("rec")) return null;
    const phase = await core.get(ctx.orgSlug, "PHASES", phaseRecId).catch(() => null);
    if (!phase) return null;
    const jobId = Array.isArray(phase["Job"]) && phase["Job"][0] ? String(phase["Job"][0]) : "";
    if (!jobId) return null;
    const job = await core.get(ctx.orgSlug, "JOBS", jobId).catch(() => null);
    if (!job) return null;
    return {
      id: phaseRecId,
      jobId,
      name: String(phase["Phase_Name"] ?? ""),
      completionPct: Number(phase["Completion_Pct"] ?? 0),
      evidenceSuggestion: String(phase["Evidence_Suggestion"] ?? "{}"),
      job: { id: jobId, code: "", name: String(job["Job_Name"] ?? "") },
    };
  }
  return db(ctx).platConPhase.findFirst({
    where: { id: Number(phaseId), orgId: ctx.orgId },
    include: { job: { select: { id: true, code: true, name: true } } },
  });
}

/** Upload a file as evidence against a phase: ingest through the document
 *  pipeline (classify → store → record), then link it to the phase. */
export async function addPhaseEvidence(
  ctx: OrgCtx,
  userName: string,
  input: { phaseId: RecordId; title?: string; name: string; mimeType: string; buf: Buffer; note?: string },
): Promise<{ ok: boolean; error?: string }> {
  const phase = await getPhase(ctx, input.phaseId);
  if (!phase) return { ok: false, error: "Phase not found" };

  const doc = await ingestDocumentFile(ctx, userName, {
    jobId: phase.jobId,
    jobCode: phase.job.code,
    title: input.title || `${phase.name} evidence — ${input.name}`,
    name: input.name,
    mimeType: input.mimeType,
    buf: input.buf,
  });
  if (!doc.id) return { ok: false, error: "Document ingestion failed" };

  await writeRecord(ctx, {
    table: "phase_evidence",
    op: "create",
    data: {
      jobId: phase.jobId,
      phaseId: phase.id,
      documentId: doc.id,
      note: input.note ?? "",
      addedBy: userName,
    },
    actor: { type: "human", name: userName },
  });
  return { ok: true };
}

/** Run the AI evidence review and store the result as a suggestion on the
 *  phase. Does NOT change completionPct — that needs a human decision. */
export async function assessPhaseEvidence(
  ctx: OrgCtx,
  userName: string,
  phaseId: RecordId,
): Promise<{ ok: boolean; demoMode: boolean; error?: string }> {
  const phase = await getPhase(ctx, phaseId);
  if (!phase) return { ok: false, demoMode: false, error: "Phase not found" };

  const evidence = airtableEnabled(ctx)
    ? await core.list(ctx.orgSlug, "PHASE_EVIDENCE", { maxRecords: 500 }).then(async (rows) =>
        Promise.all(
          rows
            .filter((r) => Array.isArray(r["Phase"]) && r["Phase"].map(String).includes(String(phase.id)))
            .map(async (r) => {
              const docId = Array.isArray(r["Document"]) && r["Document"][0] ? String(r["Document"][0]) : "";
              const doc = docId ? await core.get(ctx.orgSlug, "DOCUMENTS", docId).catch(() => null) : null;
              return {
                document: {
                  title: String(doc?.["Document_Name"] ?? ""),
                  mimeType: String(doc?.["Mime_Type"] ?? ""),
                  textContent: String(doc?.["Text_Content"] ?? ""),
                  storageProvider: String(doc?.["Storage_Provider"] ?? ""),
                  storageRef: String(doc?.["Drive_URL"] ?? ""),
                },
              };
            }),
        ),
      )
    : await db(ctx).platConPhaseEvidence.findMany({
        where: { phaseId: Number(phase.id), orgId: ctx.orgId },
        include: { document: true },
        orderBy: { createdAt: "asc" },
      });
  if (evidence.length === 0) {
    return { ok: false, demoMode: false, error: "No evidence attached to this phase yet" };
  }

  // Images go to the vision call; text-bearing documents go in as snippets;
  // anything else (e.g. video) is stored evidence but not machine-readable.
  const images: VisionImage[] = [];
  const textBits: string[] = [];
  let unreadable = 0;
  for (const ev of evidence) {
    const doc = ev.document;
    if (VISION_MIMES.has(doc.mimeType) && images.length < MAX_IMAGES && doc.storageProvider && doc.storageRef) {
      try {
        const buf = await getStorerFor(doc.storageProvider).get(doc.storageRef);
        if (buf.length <= MAX_IMAGE_BYTES) {
          images.push({ b64: buf.toString("base64"), media_type: doc.mimeType, label: doc.title });
        } else unreadable++;
      } catch {
        unreadable++;
      }
    } else if (doc.textContent.trim()) {
      textBits.push(`— ${doc.title}:\n${doc.textContent.slice(0, 2000)}`);
    } else {
      unreadable++;
    }
  }

  const siblings = airtableEnabled(ctx)
    ? await core.list(ctx.orgSlug, "PHASES", { maxRecords: 1000 }).then((rows) =>
        rows
          .filter(
            (p) =>
              Array.isArray(p["Job"]) &&
              p["Job"].map(String).includes(String(phase.jobId)) &&
              p["Is_AI_Draft"] !== true,
          )
          .sort((a, b) => Number(a["Sort_Order"] ?? 0) - Number(b["Sort_Order"] ?? 0))
          .map((p) => ({
            name: String(p["Phase_Name"] ?? ""),
            status: String(p["Status"] ?? "pending"),
            completionPct: Number(p["Completion_Pct"] ?? 0),
          })),
      )
    : await db(ctx).platConPhase.findMany({
        where: { jobId: Number(phase.jobId), orgId: ctx.orgId, isAiDraft: false },
        orderBy: { sortOrder: "asc" },
        select: { name: true, status: true, completionPct: true },
      });

  const { system, version } = getPrompt("phase.evidence_assess", {
    phaseName: phase.name,
    jobName: phase.job.name,
    currentPct: String(phase.completionPct),
    phaseList: siblings.map((p) => `${p.name} (${p.status}, ${p.completionPct}%)`).join("; "),
  });
  const userText =
    `Evidence supplied: ${images.length} photo(s)${textBits.length ? `, ${textBits.length} document extract(s)` : ""}` +
    `${unreadable ? ` (${unreadable} further file(s) attached but not machine-readable, e.g. video)` : ""}.\n` +
    (textBits.length ? `\nDocument extracts:\n${textBits.join("\n\n")}\n\n` : "") +
    "Assess the completion of the phase from this evidence.";

  const res = images.length
    ? await callClaudeVisionMulti(system, userText, images, { maxTokens: 1200, model: modelFor("vision") })
    : await callClaude(system, userText, { maxTokens: 1200, model: modelFor("extraction") });

  let suggestion: EvidenceSuggestion;
  if (res.demo_mode) {
    suggestion = {
      suggestedPct: Math.min(90, 20 + evidence.length * 15),
      confidence: 30,
      observations: [`${evidence.length} evidence item(s) on file — simulated review.`],
      missingEvidence: ["Configure ANTHROPIC_API_KEY for real evidence analysis."],
      rationale: "Demo mode — suggestion simulated from evidence count.",
      evidenceCount: evidence.length,
      imageCount: images.length,
      demoMode: true,
      suggestedAt: new Date().toISOString(),
    };
  } else {
    try {
      const parsed = JSON.parse(res.content.replace(/^```(json)?|```$/g, "").trim());
      suggestion = {
        suggestedPct: clampPct(parsed.suggestedPct),
        confidence: clampPct(parsed.confidence),
        observations: Array.isArray(parsed.observations) ? parsed.observations.map(String).slice(0, 10) : [],
        missingEvidence: Array.isArray(parsed.missingEvidence) ? parsed.missingEvidence.map(String).slice(0, 10) : [],
        rationale: String(parsed.rationale ?? "").slice(0, 1000),
        evidenceCount: evidence.length,
        imageCount: images.length,
        demoMode: false,
        suggestedAt: new Date().toISOString(),
      };
    } catch {
      return { ok: false, demoMode: false, error: "AI response was not parseable — try again" };
    }
  }

  await writeRecord(ctx, {
    table: "phase",
    op: "update",
    recordId: phase.id,
    data: { evidenceSuggestion: JSON.stringify(suggestion) },
    actor: { type: "ai", name: "Phase Evidence Review" },
    requireApproval: false, // annotation only — completionPct is untouched
  });
  if (!airtableEnabled(ctx)) {
    await db(ctx).platExecutionLog.updateMany({
      where: { orgId: ctx.orgId, targetTable: "plat_con_phase", targetId: Number(phase.id), promptVersion: "" },
      data: { promptVersion: version },
    });
  }
  return { ok: true, demoMode: suggestion.demoMode };
}

/** Human decision: apply the suggestion (possibly adjusted). An adjustment
 *  emits a correction so the learning loop hears about the disagreement. */
export async function applyEvidenceSuggestion(
  ctx: OrgCtx,
  userName: string,
  phaseId: RecordId,
  finalPct: number,
): Promise<{ ok: boolean; error?: string }> {
  const phase = await getPhase(ctx, phaseId);
  if (!phase) return { ok: false, error: "Phase not found" };
  const suggestion = parseSuggestion(phase.evidenceSuggestion);
  if (!suggestion) return { ok: false, error: "No suggestion pending on this phase" };

  const pct = clampPct(finalPct);
  const status = pct >= 100 ? "complete" : pct > 0 ? "in_progress" : "pending";
  await writeRecord(ctx, {
    table: "phase",
    op: "update",
    recordId: phase.id,
    data: { completionPct: pct, status, evidenceSuggestion: "{}" },
    actor: { type: "human", name: userName },
  });

  if (pct !== suggestion.suggestedPct) {
    await emitCorrection(
      ctx,
      { type: "human", name: userName },
      {
        jobId: typeof phase.jobId === "number" ? phase.jobId : undefined,
        entityType: "phase",
        entityId: typeof phase.id === "number" ? phase.id : undefined,
        dimension: "phase.completion_pct",
        aiValue: suggestion.suggestedPct,
        humanValue: pct,
        sourceModule: "module5",
        rootCauseCategory: "Estimation Error",
        rootCause: "Human adjusted the evidence-suggested completion before applying",
        phase: phase.name,
      },
    );
  }
  return { ok: true };
}

/** Human decision: reject the suggestion outright; completion is unchanged. */
export async function dismissEvidenceSuggestion(
  ctx: OrgCtx,
  userName: string,
  phaseId: RecordId,
): Promise<{ ok: boolean; error?: string }> {
  const phase = await getPhase(ctx, phaseId);
  if (!phase) return { ok: false, error: "Phase not found" };
  const suggestion = parseSuggestion(phase.evidenceSuggestion);
  if (!suggestion) return { ok: false, error: "No suggestion pending on this phase" };

  await writeRecord(ctx, {
    table: "phase",
    op: "update",
    recordId: phase.id,
    data: { evidenceSuggestion: "{}" },
    actor: { type: "human", name: userName },
  });
  await emitCorrection(
    ctx,
    { type: "human", name: userName },
    {
      jobId: typeof phase.jobId === "number" ? phase.jobId : undefined,
      entityType: "phase",
      entityId: typeof phase.id === "number" ? phase.id : undefined,
      dimension: "phase.completion_pct",
      aiValue: suggestion.suggestedPct,
      humanValue: phase.completionPct,
      sourceModule: "module5",
      rootCauseCategory: "Model Error",
      rootCause: "Evidence-based completion suggestion dismissed — completion left unchanged",
      phase: phase.name,
    },
  );
  return { ok: true };
}
