// Weekly reports — AI-generated from live job data, human approval before
// sending (doc module 8: client-facing outputs).
//
// Storage model differs by backend. Postgres keeps the rich plat_con_weeklyreport
// model (+ an immutable DOCUMENTS snapshot). Airtable (Spec 12) has no
// WEEKLY_REPORTS table, so a report IS a DOCUMENTS row: the markdown body in
// Text_Content, the lifecycle (week ending, draft→approved→sent) in AI_Analysis
// under a module8 block (see reportDoc.ts). Both paths go through writeRecord, so
// the audit log + approval discipline are unchanged.

import { airtableEnabled, core } from "@/lib/airtable";
import { callClaude } from "@/lib/claude";
import { loadJobContext } from "@/lib/platform/jobContextSource";
import { modelFor } from "@/lib/platform/modelRouter";
import { getPrompt } from "@/lib/platform/prompts";
import { emitOutboundEvent } from "@/lib/platform/outbox";
import { ALL_SCOPES, FINANCE_SCOPES, reportDef, type ReportScope } from "@/lib/platform/reportCatalog";
import {
  buildReportAnalysis,
  parseReportModule8,
  patchReportAnalysis,
  REPORT_DOC_TYPE,
} from "@/lib/platform/reportDoc";
import { writeRecord, type RecordId } from "@/lib/platform/recordWriter";
import { getStorer } from "@/lib/platform/storage";
import { OrgCtx } from "@/lib/platform/types";
import { generateManagedDocument } from "@/services/platform/documents";

function applyWeeklyTemplate(content: string): string {
  const text = content.trim();
  const blocks: string[] = [];
  const add = (heading: string, fallback: string) => {
    if (text.includes(heading)) return;
    blocks.push(heading, fallback, "");
  };
  if (!text) {
    return [
      "## Progress",
      "_No progress summary provided._",
      "",
      "## Budget",
      "_Budget summary pending._",
      "",
      "## Risks",
      "_No risks reported._",
      "",
      "## Next week",
      "_Next-week plan pending._",
    ].join("\n");
  }
  add("## Progress", text);
  add("## Budget", "_Budget summary pending._");
  add("## Risks", "_No risks reported._");
  add("## Next week", "_Next-week plan pending._");
  return blocks.length ? `${text}\n\n${blocks.join("\n").trim()}` : text;
}

type JobContext = NonNullable<Awaited<ReturnType<typeof loadJobContext>>>;

/** Serialize only the requested job-context slices (CLS: finance slices are
 *  filtered out before this is called). Keys match the legacy weekly context. */
function buildReportContext(job: JobContext, scopes: readonly ReportScope[]): string {
  const slices: Record<ReportScope, () => [string, unknown]> = {
    phases: () => [
      "phases",
      job.phases.map((p) => ({ name: p.name, status: p.status, pct: p.completionPct })),
    ],
    risks: () => [
      "openRisks",
      job.risks.map((r) => ({ desc: r.description, score: r.likelihood * r.impact })),
    ],
    budget: () => [
      "budget",
      job.budget.map((b) => ({ category: b.category, budget: b.budgetAmount, actual: b.actualAmount })),
    ],
    cashflow: () => [
      "cashflow",
      job.cashflow.map((c) => ({ period: c.period, projected: c.projected, actual: c.actual })),
    ],
    actions: () => [
      "openActions",
      job.actions.map((a) => ({ title: a.title, owner: a.owner, due: a.dueDate })),
    ],
    variations: () => [
      "variations",
      job.variations.map((v) => ({ ref: v.refNumber, title: v.title, cost: v.costImpact, status: v.status })),
    ],
  };
  const out: Record<string, unknown> = {
    job: { name: job.name, completionPct: job.completionPct, healthScore: job.healthScore },
  };
  for (const s of scopes) {
    const [key, value] = slices[s]();
    out[key] = value;
  }
  return JSON.stringify(out);
}

// ── deterministic register renderers (Phase 2) ─────────────────────────────
const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const cell = (v: unknown): string => String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (header: string[], rows: unknown[][]): string =>
  [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
const pct = (num: number, den: number): string =>
  den ? `${Math.round((num / den) * 1000) / 10}%` : "—";

const REGISTERS: Record<string, (job: JobContext, finance: boolean) => string> = {
  budget_variance: (job) => {
    if (!job.budget.length) return "_No budget lines._";
    const tb = job.budget.reduce((s, b) => s + b.budgetAmount, 0);
    const ta = job.budget.reduce((s, b) => s + b.actualAmount, 0);
    const rows = job.budget.map((b) => [
      b.category,
      money(b.budgetAmount),
      money(b.actualAmount),
      money(b.actualAmount - b.budgetAmount),
      pct(b.actualAmount - b.budgetAmount, b.budgetAmount),
    ]);
    rows.push(["**Total**", money(tb), money(ta), money(ta - tb), pct(ta - tb, tb)]);
    return table(["Category", "Budget", "Actual", "Variance", "Var %"], rows);
  },
  cashflow_forecast: (job) => {
    const cf = job.cashflow.length
      ? table(
          ["Period", "Projected", "Actual", "Variance"],
          job.cashflow.map((c) => [c.period, money(c.projected), money(c.actual), money(c.actual - c.projected)]),
        )
      : "_No cashflow periods._";
    const pending = job.variations.filter((v) => v.status !== "approved");
    return `${cf}\n\n## Pending variation exposure\n\n${
      pending.length
        ? table(["Ref", "Variation", "Cost impact"], pending.map((v) => [v.refNumber || "—", v.title, money(v.costImpact)]))
        : "_None._"
    }`;
  },
  risk_register: (job) =>
    job.risks.length
      ? table(
          ["Risk", "Likelihood", "Impact", "Score"],
          [...job.risks]
            .sort((a, b) => b.likelihood * b.impact - a.likelihood * a.impact)
            .map((r) => [r.description, r.likelihood, r.impact, r.likelihood * r.impact]),
        )
      : "_No open risks._",
  variations_register: (job, finance) =>
    job.variations.length
      ? table(
          finance ? ["Ref", "Variation", "Status", "Cost impact"] : ["Ref", "Variation", "Status"],
          job.variations.map((v) =>
            finance ? [v.refNumber || "—", v.title, v.status, money(v.costImpact)] : [v.refNumber || "—", v.title, v.status],
          ),
        )
      : "_No variations on record._",
  actions_status: (job) => {
    if (!job.actions.length) return "_No open actions._";
    const today = new Date().toISOString().slice(0, 10);
    const due = (d: Date | null): string => (d ? new Date(d).toISOString().slice(0, 10) : "—");
    const overdue = job.actions.filter((a) => a.dueDate && due(a.dueDate) < today).length;
    return `${overdue} of ${job.actions.length} open actions overdue.\n\n${table(
      ["Action", "Owner", "Due", ""],
      job.actions.map((a) => [a.title, a.owner || "—", due(a.dueDate), a.dueDate && due(a.dueDate) < today ? "⚠ overdue" : ""]),
    )}`;
  },
  phase_schedule: (job) =>
    job.phases.length
      ? table(["Phase", "Status", "Complete %"], job.phases.map((p) => [p.name, p.status, `${p.completionPct}%`]))
      : "_No phases._",
};

export interface ReportViewer {
  name: string;
  /** reportingCapabilities(role).showFinancialDetail — gates finance slices. */
  financeDetail: boolean;
}

export async function generateReport(
  ctx: OrgCtx,
  viewer: ReportViewer,
  reportId: string,
  jobId: RecordId,
  periodEnding: string,
): Promise<{ id?: RecordId; demoMode: boolean }> {
  const def = reportDef(reportId);
  if (!def) {
    // Not in the code catalog → try the org's saved templates (Phase 4):
    // a template is a stored promptSpec, so it generates via the custom path.
    const { getReportTemplate } = await import("@/lib/platform/controlPlane");
    const tpl = await getReportTemplate(ctx.orgSlug, reportId);
    if (!tpl) throw new Error(`Unknown report type: ${reportId}`);
    return generateCustomReport(ctx, viewer, {
      jobId,
      periodEnding,
      prompt: tpl.prompt,
      scopes: tpl.scopes,
    });
  }
  const job = await loadJobContext(ctx, jobId);
  if (!job) throw new Error("Job not found");

  if (def.financeOnly && !viewer.financeDetail) {
    throw new Error("This report requires financial access.");
  }

  let content: string;
  let demoMode = false;
  if (def.kind === "deterministic") {
    const body = REGISTERS[def.id](job, viewer.financeDetail);
    let summary = "";
    if (def.aiSummary) {
      const { system } = getPrompt("reports.register_summary");
      const res = await callClaude(system, `${def.title}, ${def.periodLabel} ${periodEnding}:\n${body}`, {
        model: modelFor("drafting"),
        maxTokens: 300,
      });
      demoMode = res.demo_mode;
      if (!res.demo_mode) summary = `## Summary\n\n${res.content.trim()}\n\n`;
    }
    content = `# ${job.name} — ${def.title}\n\n_${def.periodLabel} ${periodEnding}_\n\n${summary}${body}`;
  } else {
    const scopes = def.scopes.filter((s) => viewer.financeDetail || !FINANCE_SCOPES.includes(s));
    const context = buildReportContext(job, scopes);
    const { system } = getPrompt(def.promptKey!);
    const res = await callClaude(system, `${def.periodLabel} ${periodEnding}. Project data:\n${context}`, {
      model: modelFor("drafting"),
      maxTokens: 1200,
    });
    demoMode = res.demo_mode;
    const contentRaw = res.demo_mode
      ? `## Progress\n_Demo mode — no API key. This report was generated from a template._\n\n- ${job.phases.map((p) => `${p.name}: ${p.completionPct}%`).join("\n- ")}\n\n## Risks\n- ${job.risks.length} open risks\n\n## Next week\n- ${job.actions.length} open actions to progress`
      : res.content;
    content = def.sectionTemplate ? applyWeeklyTemplate(contentRaw) : contentRaw.trim();
  }
  const title =
    def.id === "weekly_progress"
      ? `Week ending ${periodEnding}`
      : `${def.title} — ${periodEnding}`;

  // Airtable (Spec 12): the report is a DOCUMENTS row — body in Text_Content,
  // lifecycle in AI_Analysis.module8. Doc_Status stays a neutral "Active".
  if (airtableEnabled(ctx)) {
    const stored = await getStorer()
      .put({ orgSlug: ctx.orgSlug, docType: REPORT_DOC_TYPE, name: `${title}.md` }, Buffer.from(content, "utf8"))
      .catch(() => null);
    // Supersede rule: regenerating the same (report type, period) overwrites the
    // existing draft instead of stacking duplicates. DOCUMENTS carries no job
    // link, so the match is per report+period (orgs are single-job today).
    const existing = (
      await core
        .list(ctx.orgSlug, "DOCUMENTS", {
          maxRecords: 500,
          filterByFormula: `LOWER({Document_Type})='${REPORT_DOC_TYPE.toLowerCase()}'`,
        })
        .catch(() => [])
    ).find((r) => {
      const m8 = parseReportModule8(r["AI_Analysis"]);
      return (
        m8?.status === "draft" &&
        m8.weekEnding === periodEnding &&
        (m8.reportId ?? "weekly_progress") === def.id
      );
    });
    const data = {
      jobId,
      title,
      docType: REPORT_DOC_TYPE,
      status: "Active",
      uploadedBy: viewer.name,
      textContent: content,
      storageProvider: stored?.provider ?? "",
      storageRef: stored?.ref ?? "",
      aiAnalysis: buildReportAnalysis({
        kind: "weekly_report",
        reportId: def.id,
        weekEnding: periodEnding,
        status: "draft",
        isAiGenerated: true,
        generatedAt: new Date().toISOString(),
      }),
    };
    const result = await writeRecord(
      ctx,
      existing
        ? { table: "document", op: "update", recordId: existing.id, data, actor: { type: "ai", name: "Report Writer" } }
        : { table: "document", op: "create", data, actor: { type: "ai", name: "Report Writer" } },
    );
    return { id: result.recordId ?? existing?.id, demoMode };
  }

  // Postgres: rich weekly_report row + an immutable DOCUMENTS snapshot for audit.
  const result = await writeRecord(ctx, {
    table: "weekly_report",
    op: "create",
    data: {
      jobId,
      weekEnding: periodEnding,
      title,
      content,
      isAiGenerated: true,
      status: "draft",
    },
    actor: { type: "ai", name: "Report Writer" },
  });
  if (result.recordId != null) {
    const snapshot = await generateManagedDocument(ctx, viewer.name, {
      jobId,
      title: `${title} (snapshot)`,
      docType: "report",
      outputType: "weekly_report_snapshot",
      format: "pdf",
      body: content,
      traceability: {
        sourceModule: "module8.weekly_reports",
        sourceRecordId: result.recordId,
      },
    });
    if (snapshot.id != null) {
      await writeRecord(ctx, {
        table: "weekly_report",
        op: "update",
        recordId: result.recordId,
        data: { documentId: snapshot.id },
        actor: { type: "system", name: "Document Management" },
      });
    }
  }
  return { id: result.recordId, demoMode };
}

export const CUSTOM_REPORT_ID = "custom_report";

/** Phase 3: prompt-built report. The promptSpec is stored in module8 for audit
 *  and Regenerate (pass recordId to re-run the same spec onto that record —
 *  the result is a fresh draft). Airtable-only, like all catalog work. */
export async function generateCustomReport(
  ctx: OrgCtx,
  viewer: ReportViewer,
  args: {
    jobId: RecordId;
    periodEnding: string;
    prompt: string;
    scopes: string[];
    recordId?: RecordId;
  },
): Promise<{ id?: RecordId; demoMode: boolean }> {
  if (!airtableEnabled(ctx)) throw new Error("Custom reports require the Airtable backend.");
  const job = await loadJobContext(ctx, args.jobId);
  if (!job) throw new Error("Job not found");

  // Server-side CLS: intersect the requested scopes with what this viewer may
  // see, whatever the client sent. Empty request = all allowed slices.
  const requested = args.scopes.length ? args.scopes : [...ALL_SCOPES];
  const scopes = ALL_SCOPES.filter(
    (s) => requested.includes(s) && (viewer.financeDetail || !FINANCE_SCOPES.includes(s)),
  );
  const context = buildReportContext(job, scopes);

  const { system } = getPrompt("reports.custom");
  const res = await callClaude(
    system,
    `As at ${args.periodEnding}. Request: ${args.prompt}\n\nProject data:\n${context}`,
    { model: modelFor("drafting"), maxTokens: 1500 },
  );
  const content = res.demo_mode
    ? `_Demo mode — no API key. Request was: ${args.prompt}_`
    : res.content.trim();
  const title = `Custom: ${args.prompt.slice(0, 60)}${args.prompt.length > 60 ? "…" : ""} — ${args.periodEnding}`;

  const data = {
    jobId: args.jobId,
    title,
    docType: REPORT_DOC_TYPE,
    status: "Active",
    uploadedBy: viewer.name,
    textContent: content,
    aiAnalysis: buildReportAnalysis({
      kind: "weekly_report",
      reportId: CUSTOM_REPORT_ID,
      weekEnding: args.periodEnding,
      status: "draft",
      isAiGenerated: true,
      generatedAt: new Date().toISOString(),
      promptSpec: { prompt: args.prompt, scopes, jobId: String(args.jobId) },
    }),
  };
  const result = await writeRecord(
    ctx,
    args.recordId != null
      ? { table: "document", op: "update", recordId: args.recordId, data, actor: { type: "ai", name: "Report Writer" } }
      : { table: "document", op: "create", data, actor: { type: "ai", name: "Report Writer" } },
  );
  return { id: result.recordId ?? args.recordId, demoMode: res.demo_mode };
}

/** Legacy alias for AI/system callers (scheduler, assistant executor) — the
 *  weekly report has always carried full financial detail on those paths. */
export function generateWeeklyReport(
  ctx: OrgCtx,
  userName: string,
  jobId: RecordId,
  weekEnding: string,
): Promise<{ id?: RecordId; demoMode: boolean }> {
  return generateReport(ctx, { name: userName, financeDetail: true }, "weekly_progress", jobId, weekEnding);
}

export async function approveReport(ctx: OrgCtx, userName: string, id: RecordId): Promise<void> {
  if (airtableEnabled(ctx)) {
    const doc = await core.get(ctx.orgSlug, "DOCUMENTS", String(id)).catch(() => null);
    await writeRecord(ctx, {
      table: "document",
      op: "update",
      recordId: id,
      data: {
        aiAnalysis: patchReportAnalysis(doc?.["AI_Analysis"], {
          status: "approved",
          approvedBy: userName,
          approvedAt: new Date().toISOString(),
        }),
      },
      actor: { type: "human", name: userName },
    });
    // Spec 12 live-vs-snapshot rule (lock plan §8.6): the APPROVED report also
    // renders as an immutable, hashed PDF DOCUMENTS snapshot — parity with the
    // Postgres path and the tender report. Draft iterations stay cheap
    // markdown; best-effort so a render failure never blocks the approval.
    const title = typeof doc?.["Document_Name"] === "string" ? (doc["Document_Name"] as string) : "Report";
    const body = typeof doc?.["Text_Content"] === "string" ? (doc["Text_Content"] as string) : "";
    const jobLink = Array.isArray(doc?.["Job"]) && doc["Job"].length > 0 ? String(doc["Job"][0]) : undefined;
    if (body.trim()) {
      await generateManagedDocument(ctx, userName, {
        jobId: jobLink,
        title: `${title} — approved snapshot`,
        body,
        docType: "report",
        outputType: "report_snapshot",
        format: "pdf",
        traceability: { sourceModule: "module8", sourceRecordId: String(id) },
      }).catch(() => {});
    }
    return;
  }
  await writeRecord(ctx, {
    table: "weekly_report",
    op: "update",
    recordId: id,
    data: { status: "approved", approvedBy: userName, approvedAt: new Date().toISOString() },
    actor: { type: "human", name: userName },
  });
}

export async function markReportSent(ctx: OrgCtx, userName: string, id: RecordId): Promise<void> {
  if (airtableEnabled(ctx)) {
    const doc = await core.get(ctx.orgSlug, "DOCUMENTS", String(id)).catch(() => null);
    await writeRecord(ctx, {
      table: "document",
      op: "update",
      recordId: id,
      data: {
        aiAnalysis: patchReportAnalysis(doc?.["AI_Analysis"], {
          status: "sent",
          sentAt: new Date().toISOString(),
        }),
      },
      actor: { type: "human", name: userName },
    });
  } else {
    await writeRecord(ctx, {
      table: "weekly_report",
      op: "update",
      recordId: id,
      data: { status: "sent", sentAt: new Date().toISOString() },
      actor: { type: "human", name: userName },
    });
  }
  await emitOutboundEvent(ctx, "report.ready", {
    entityType: "weekly_report",
    entityId: id,
    summary: "Weekly report sent",
    data: { sentBy: userName },
  });
}
