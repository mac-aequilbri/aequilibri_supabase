import type Anthropic from "@anthropic-ai/sdk";
import type { ChatStreamEvent } from "@/lib/claude";
import { airtableEnabled, core } from "@/lib/airtable";
import { db, prisma } from "@/lib/db";
import { normalizeTeamRole } from "@/lib/platform/module1Governance";
import { isPlatformAdmin } from "@/lib/platform/org-context";
import { getPrompt } from "@/lib/platform/prompts";
import { Actor, OrgCtx } from "@/lib/platform/types";
import type { RecordId } from "@/lib/platform/recordWriter";
import { domainVocabBlock } from "@/lib/platform/domainLabels";
import { learningPromptText } from "../learning";
import { jobContextBlock } from "./context";
import type { ToolOutcome } from "./executor";
import { runOrchestrator, type Specialist } from "../agents/orchestrator";
import { SPECIALISTS } from "../agents/registry";
import { PROPOSED_PENDING_FORMULA } from "@/lib/platform/pendingWritesSource";
import { currentJobScope, inScope } from "@/lib/platform/rls";

const HISTORY_LIMIT = 20;

const formulaSafe = (v: string): string => v.replace(/'/g, "");
const OPEN_ISSUES_FORMULA = `OR({Status}='Open',{Status}='In Progress')`;

/** Scalar fields worth grounding on — omits the many link arrays that make a
 *  raw JOBS row huge in the prompt. */
const JOB_SUMMARY_FIELDS = [
  "Job_Name",
  "Status",
  "Target_Completion",
  "Outcome",
  "Estimated_Value",
  "Actual_Value",
  "Variance_Percent",
] as const;

function compactJob(job: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { id: job.id };
  for (const k of JOB_SUMMARY_FIELDS) if (job[k] != null) out[k] = job[k];
  return out;
}

interface ChatMessageRow {
  id: RecordId;
  role: string;
  content: string;
  toolCalls: string;
  createdAt: Date;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function dt(v: unknown): Date {
  const s = str(v);
  const d = s ? new Date(s) : new Date(0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

async function listSessionMessagesAirtable(ctx: OrgCtx, sessionId: RecordId): Promise<ChatMessageRow[]> {
  const rows = await core.list(ctx.orgSlug, "CHAT_MESSAGES", {
    filterByFormula: `{Session_Id}='${formulaSafe(String(sessionId))}'`,
  });
  return rows
    .map((r) => ({
      id: r.id,
      role: str(r["Role"]),
      content: str(r["Content"]),
      toolCalls: str(r["Tool_Calls"]) || "[]",
      createdAt: dt(r["Created_At"]),
    }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Which surface a session belongs to. The project assistant (/assistant) and
 *  the standalone chat (/chat) share the same tables but keep separate threads.
 *  The channel is encoded in the session title so the two never pick up each
 *  other's session — no schema field needed across the Airtable/Postgres stores.
 *  Project keeps the fixed "Session" title (one rolling thread, unchanged);
 *  standalone conversations are titled "chat: <name>", so each carries its own
 *  display name for the /chat history list. */
export type SessionChannel = "project" | "standalone";
const PROJECT_TITLE = "Session";
const STANDALONE_PREFIX = "chat:";
const DEFAULT_CHAT_TITLE = "New chat";

const encodeChatTitle = (display: string): string =>
  `${STANDALONE_PREFIX} ${display.trim() || DEFAULT_CHAT_TITLE}`;
const isStandaloneTitle = (raw: string): boolean =>
  raw.trimStart().toLowerCase().startsWith(STANDALONE_PREFIX);
function chatDisplayTitle(raw: string): string {
  const t = raw.trimStart();
  if (!isStandaloneTitle(t)) return t || DEFAULT_CHAT_TITLE;
  return t.slice(STANDALONE_PREFIX.length).trim() || DEFAULT_CHAT_TITLE;
}

/** A short conversation name derived from the first user message. */
export function deriveChatTitle(message: string): string {
  const line = message.replace(/\s+/g, " ").trim();
  if (!line) return DEFAULT_CHAT_TITLE;
  return line.length > 48 ? `${line.slice(0, 47).trimEnd()}…` : line;
}

export interface ChatSessionSummary {
  id: RecordId;
  title: string;
  startedAt: Date;
  ended: boolean;
}

export async function getOrCreateSession(
  ctx: OrgCtx,
  jobId?: RecordId,
  channel: SessionChannel = "project",
): Promise<RecordId> {
  // Standalone reuses the most recent conversation (or opens a fresh one); it is
  // the /chat page + stream-route fallback that manages the multi-thread list.
  if (channel === "standalone") {
    const existing = await listChatSessions(ctx);
    return existing.length ? existing[0].id : createChatSession(ctx);
  }
  if (airtableEnabled(ctx)) {
    const rows = await core.list(ctx.orgSlug, "CHAT_SESSIONS", { maxRecords: 200 });
    const open = rows
      .filter((r) => !str(r["Ended_At"]) && str(r["Session_Title"]) === PROJECT_TITLE)
      .sort((a, b) => dt(b["Started_At"]).getTime() - dt(a["Started_At"]).getTime())[0];
    if (open) return open.id;
    const created = await core.create(ctx.orgSlug, "CHAT_SESSIONS", {
      Session_Title: PROJECT_TITLE,
      Job_Id: jobId == null ? "" : String(jobId),
      Started_At: new Date().toISOString(),
      Summary: "",
    });
    return created.id;
  }
  const open = await db(ctx).platChatSession.findFirst({
    where: { orgId: ctx.orgId, endedAt: null, title: PROJECT_TITLE },
    orderBy: { startedAt: "desc" },
  });
  if (open) return open.id;
  const session = await db(ctx).platChatSession.create({
    data: { orgId: ctx.orgId, jobId: typeof jobId === "number" ? jobId : undefined, title: PROJECT_TITLE },
  });
  return session.id;
}

/** All standalone-chat conversations for the org, most recent first. */
export async function listChatSessions(ctx: OrgCtx): Promise<ChatSessionSummary[]> {
  if (airtableEnabled(ctx)) {
    const rows = await core.list(ctx.orgSlug, "CHAT_SESSIONS", { maxRecords: 200 });
    return rows
      .filter((r) => isStandaloneTitle(str(r["Session_Title"])))
      .map((r) => ({
        id: r.id,
        title: chatDisplayTitle(str(r["Session_Title"])),
        startedAt: dt(r["Started_At"]),
        ended: Boolean(str(r["Ended_At"])),
      }))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }
  const rows = await db(ctx).platChatSession.findMany({
    where: { orgId: ctx.orgId, title: { startsWith: STANDALONE_PREFIX } },
    orderBy: { startedAt: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    title: chatDisplayTitle(r.title),
    startedAt: r.startedAt,
    ended: Boolean(r.endedAt),
  }));
}

/** Open a fresh standalone conversation and return its id. */
export async function createChatSession(ctx: OrgCtx, title?: string): Promise<RecordId> {
  const encoded = encodeChatTitle(title ?? DEFAULT_CHAT_TITLE);
  if (airtableEnabled(ctx)) {
    const created = await core.create(ctx.orgSlug, "CHAT_SESSIONS", {
      Session_Title: encoded,
      Job_Id: "",
      Started_At: new Date().toISOString(),
      Summary: "",
    });
    return created.id;
  }
  const session = await db(ctx).platChatSession.create({ data: { orgId: ctx.orgId, title: encoded } });
  return session.id;
}

/** Rename a standalone conversation (used for first-message auto-titling). */
export async function renameChatSession(ctx: OrgCtx, sessionId: RecordId, title: string): Promise<void> {
  const encoded = encodeChatTitle(title);
  if (airtableEnabled(ctx)) {
    await core.update(ctx.orgSlug, "CHAT_SESSIONS", String(sessionId), { Session_Title: encoded });
    return;
  }
  await db(ctx).platChatSession.updateMany({
    where: { id: Number(sessionId), orgId: ctx.orgId },
    data: { title: encoded },
  });
}

/** Permanently delete a standalone conversation and its messages. Callers must
 *  first confirm the id belongs to this org's standalone set (isChatSession). */
export async function deleteChatSession(ctx: OrgCtx, sessionId: RecordId): Promise<void> {
  if (airtableEnabled(ctx)) {
    const msgs = await core.list(ctx.orgSlug, "CHAT_MESSAGES", {
      filterByFormula: `{Session_Id}='${formulaSafe(String(sessionId))}'`,
    });
    // deleteRecords chunks the 10-per-call Airtable limit and no-ops on empty.
    await core.remove(ctx.orgSlug, "CHAT_MESSAGES", msgs.map((m) => m.id));
    await core.remove(ctx.orgSlug, "CHAT_SESSIONS", [String(sessionId)]);
    return;
  }
  await db(ctx).platChatMessage.deleteMany({ where: { orgId: ctx.orgId, sessionId: Number(sessionId) } });
  await db(ctx).platChatSession.deleteMany({ where: { id: Number(sessionId), orgId: ctx.orgId } });
}

/** Whether an id is one of this org's standalone conversations — the ownership
 *  gate for rename/delete, so a forged ?s= / form id can't touch a project or
 *  cross-org session. */
export async function isChatSession(ctx: OrgCtx, sessionId: RecordId): Promise<boolean> {
  const sessions = await listChatSessions(ctx);
  return sessions.some((s) => String(s.id) === String(sessionId));
}

/** Resolve which standalone conversation to show: the requested id when it is a
 *  valid standalone session for this org, else the most recent, else a new one.
 *  Validating against the org's standalone list also blocks viewing a project or
 *  cross-org session by guessing its id in ?s=. */
export async function resolveChatSession(ctx: OrgCtx, requestedId?: RecordId): Promise<RecordId> {
  const sessions = await listChatSessions(ctx);
  if (requestedId != null) {
    const match = sessions.find((s) => String(s.id) === String(requestedId));
    if (match) return match.id;
  }
  return sessions.length ? sessions[0].id : createChatSession(ctx);
}

export async function endSession(
  ctx: OrgCtx,
  sessionId: RecordId,
  /** Spec 12 session protocol (lock plan §6.3): the close review's outcome —
   *  when provided, the session summary is stamped on CHAT_SESSIONS and a
   *  distinct session-close EXECUTION_LOG entry is written (the cross-session
   *  persistence record; per-turn logs cover the turns, not the close). */
  close?: { summary?: string; rulesFlagged?: string[]; correctionCaptured?: boolean },
): Promise<void> {
  if (airtableEnabled(ctx)) {
    await core.update(ctx.orgSlug, "CHAT_SESSIONS", String(sessionId), {
      Ended_At: new Date().toISOString(),
      ...(close?.summary ? { Summary: close.summary } : {}),
    });
    if (close) {
      await core
        .create(ctx.orgSlug, "EXECUTION_LOG", {
          Log_Entry: "session close",
          Action_Type: "Chat",
          Tables_Affected: "CHAT_SESSIONS",
          Summary: JSON.stringify({
            sessionClose: {
              sessionId: String(sessionId),
              summary: close.summary ?? "",
              rulesFlagged: close.rulesFlagged ?? [],
              correctionCaptured: close.correctionCaptured ?? false,
            },
          }),
          Initiated_By: "Owner",
          Status: "Done",
          Date_Time: new Date().toISOString(),
        })
        .catch(() => {});
    }
    return;
  }
  await db(ctx).platChatSession.updateMany({
    where: { id: Number(sessionId), orgId: ctx.orgId },
    data: { endedAt: new Date() },
  });
}

export async function listMessages(ctx: OrgCtx, sessionId: RecordId): Promise<ChatMessageRow[]> {
  if (airtableEnabled(ctx)) {
    return listSessionMessagesAirtable(ctx, sessionId);
  }
  const rows = await db(ctx).platChatMessage.findMany({
    where: { orgId: ctx.orgId, sessionId: Number(sessionId) },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls,
    createdAt: m.createdAt,
  }));
}

/** Compact data context so the model grounds its answers in real records —
 *  RLS-scoped, so a scoped viewer's assistant is grounded only on their jobs
 *  (and org-global rows), never the whole org's projects/counts. */
async function dataContext(ctx: OrgCtx): Promise<string> {
  const scope = await currentJobScope(ctx);
  const firstLink = (v: unknown): string | null =>
    Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
  if (airtableEnabled(ctx)) {
    // Read a wider page when scoping so the viewer's jobs aren't missed by the
    // grounding snapshot; whole-tenant viewers keep the cheap top-10 read.
    const [jobsAll, actionsAll, pendingAll] = await Promise.all([
      core.list(ctx.orgSlug, "JOBS", { maxRecords: scope.mode === "all" ? 10 : 200 }),
      core.list(ctx.orgSlug, "ISSUES", { filterByFormula: OPEN_ISSUES_FORMULA }),
      core.list(ctx.orgSlug, "PENDING_WRITES", { filterByFormula: PROPOSED_PENDING_FORMULA }),
    ]);
    const jobs = (scope.mode === "all" ? jobsAll : jobsAll.filter((j) => inScope(scope, j.id))).slice(0, 10);
    const actions = scope.mode === "all" ? actionsAll : actionsAll.filter((a) => inScope(scope, firstLink(a["Job"])));
    const pending = scope.mode === "all" ? pendingAll : pendingAll.filter((p) => inScope(scope, str(p["Job_Id"]) || null));
    return [
      `Jobs: ${JSON.stringify(jobs.map(compactJob))}`,
      `Open actions: ${actions.length}. Pending write proposals awaiting human approval: ${pending.length}.`,
    ].join("\n");
  }
  const ids = scope.mode === "some" ? [...scope.jobIds].map(Number).filter((n) => Number.isFinite(n)) : null;
  const jobW = ids ? { jobId: { in: ids } } : scope.mode === "none" ? { jobId: -1 } : {};
  const ownW = ids ? { id: { in: ids } } : scope.mode === "none" ? { id: -1 } : {};
  const jobs = await db(ctx).platJob.findMany({
    where: { orgId: ctx.orgId, ...ownW },
    select: {
      id: true,
      code: true,
      name: true,
      engagementType: true,
      status: true,
      completionPct: true,
      budgetTotal: true,
    },
    take: 10,
    orderBy: { updatedAt: "desc" },
  });
  const [openActions, pendingProposals] = await Promise.all([
    db(ctx).platActionHub.count({
      where: { orgId: ctx.orgId, ...jobW, status: { in: ["open", "in_progress"] } },
    }),
    db(ctx).platPendingWrite.count({ where: { orgId: ctx.orgId, ...jobW, status: "proposed" } }),
  ]);
  return [
    `Jobs: ${JSON.stringify(jobs, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}`,
    `Open actions: ${openActions}. Pending write proposals awaiting human approval: ${pendingProposals}.`,
  ].join("\n");
}

/** Spec 12 session-start protocol (lock plan §6.3): when 3 or more CORRECTIONS
 *  landed since the last ended session, surface them at session start before
 *  other work — they may prompt immediate pattern detection. Counted on
 *  CORRECTIONS.Date_Found (stamped by emitCorrection) against the most recent
 *  CHAT_SESSIONS.Ended_At. Airtable mode only; "" when below threshold. */
async function recentCorrectionsBlock(ctx: OrgCtx): Promise<string> {
  if (!airtableEnabled(ctx)) return "";
  try {
    const sessions = await core.list(ctx.orgSlug, "CHAT_SESSIONS", { maxRecords: 200 });
    const lastEnded = sessions
      .map((s) => str(s["Ended_At"]))
      .filter(Boolean)
      .sort()
      .at(-1);
    if (!lastEnded) return ""; // first session — nothing to compare against
    const cutoff = lastEnded.slice(0, 10);
    const corrections = await core.list(ctx.orgSlug, "CORRECTIONS", { maxRecords: 1000 });
    const recent = corrections.filter((c) => {
      const d = str(c["Date_Found"]);
      return d !== "" && d >= cutoff;
    }).length;
    if (recent < 3) return "";
    return `SESSION-START PROTOCOL: ${recent} corrections were captured since the last session. Surface them to the user before other work — suggest reviewing the Automation rules page; they may prompt immediate pattern detection (run the hypothesis engine).`;
  } catch {
    return "";
  }
}

export interface SendResult {
  sessionId: RecordId;
  reply: string;
  demoMode: boolean;
  outcomes: ToolOutcome[];
  pendingApprovals: RecordId[];
}

export async function sendChatMessage(
  ctx: OrgCtx,
  userName: string,
  text: string,
  opts: {
    sessionId?: RecordId;
    jobId?: RecordId;
    userRole?: string;
    onEvent?: (e: ChatStreamEvent) => void;
  } = {},
): Promise<SendResult> {
  const startedAt = Date.now();
  const sessionId = opts.sessionId ?? (await getOrCreateSession(ctx, opts.jobId));
  let userMsgId: number | undefined;
  let userMsgRecordId: string | undefined;
  if (airtableEnabled(ctx)) {
    const userMsg = await core.create(ctx.orgSlug, "CHAT_MESSAGES", {
      Session_Id: String(sessionId),
      Role: "user",
      Content: text,
      Tool_Calls: "[]",
      Created_At: new Date().toISOString(),
    });
    userMsgRecordId = userMsg.id;
  } else {
    const userMsg = await db(ctx).platChatMessage.create({
      data: { orgId: ctx.orgId, sessionId: Number(sessionId), role: "user", content: text },
    });
    userMsgId = userMsg.id;
  }

  const readsAt = Date.now();
  const [rulesBlock, context, correctionsBlock, sessionContext, vocabBlock, historyRows] = await Promise.all([
    learningPromptText(ctx),
    dataContext(ctx),
    recentCorrectionsBlock(ctx),
    // Spec 12 Module 7 context loading (lock plan §7.1): phases+RAG, budget
    // summary (finance-visible roles), issue counts, recent decisions and
    // activity — TTL-cached, invalidated by every write through recordWriter.
    jobContextBlock(ctx, { jobId: opts.jobId, role: opts.userRole }),
    domainVocabBlock(ctx),
    airtableEnabled(ctx)
      ? listSessionMessagesAirtable(ctx, sessionId).then((rows) =>
          rows.filter((m) => String(m.id) !== String(userMsgRecordId)).slice(-HISTORY_LIMIT).reverse(),
        )
      : db(ctx).platChatMessage.findMany({
          where: { orgId: ctx.orgId, sessionId: Number(sessionId), id: { lt: userMsgId! } },
          orderBy: { createdAt: "desc" },
          take: HISTORY_LIMIT,
        }),
  ]);
  const readMs = Date.now() - readsAt;

  const { system, version } = getPrompt("assistant.chat", {
    persona: ctx.config.assistant.persona,
    orgName: ctx.orgName,
    jobLine: opts.jobId ? ` (current job id ${opts.jobId})` : "",
    rulesBlock: [
      rulesBlock,
      correctionsBlock,
      sessionContext,
      vocabBlock,
      `Current user role: ${normalizeTeamRole(opts.userRole ?? "broker")}.`,
      `Role access is enforced server-side: owner has full access; builder writes actions/workstreams only (no budget, risks, decisions, or rules); architect additionally drafts variations but has no financial access; broker is read-only except raising an action to flag a decision needed. Financial tables (budget, cashflow) and learning rules are readable by the owner only — for other roles, answer without that data and note it is owner-restricted.`,
      `Current data snapshot:\n${context}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  const convo: Anthropic.MessageParam[] = [
    ...historyRows
      .reverse()
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content || "…" })),
    { role: "user", content: text },
  ];

  const actor: Actor = {
    type: "ai",
    name: ctx.config.assistant.name,
    role: opts.userRole,
    sourceMessageId: userMsgId,
  };

  // Route the turn through the orchestrator across all registered specialists.
  // Each specialist shares the same grounded base prompt (persona, rules, data
  // snapshot) plus a scope line; its tool bundle is what actually constrains it.
  // Every specialist write still passes the shared aiAuthority + role gate. The
  // Onboarding agent (Module 1) is platform-admin only, so it's excluded here
  // for everyone else (the executor re-checks on the tool itself).
  const platformAdmin = await isPlatformAdmin();
  const specialists: Specialist[] = SPECIALISTS.filter(
    (agent) => agent.key !== "onboarding" || platformAdmin,
  ).map((agent) => ({
    agent,
    system: `${system}\n\nYou are the ${agent.label} specialist for this workspace. Scope: ${agent.description} Use only the tools you have been given; if a request falls outside your scope, say so briefly so it can be routed elsewhere.`,
  }));
  const modelAt = Date.now();
  const { reply, demoMode, outcomes, delegations } = await runOrchestrator(ctx, convo, actor, {
    specialists,
    orgName: ctx.orgName,
    userRole: opts.userRole,
    onEvent: opts.onEvent,
  });
  // Per-stage latency (ms): reads = pre-model data fetch; model = full
  // orchestrator fan-out; total = whole turn. Written to EXECUTION_LOG so the
  // perf work is confirmable from the logs rather than assumed.
  const timing = { readMs, modelMs: Date.now() - modelAt, totalMs: Date.now() - startedAt };

  const pendingApprovals = outcomes
    .filter((o) => o.status === "proposed" && o.proposalId)
    .map((o) => o.proposalId!);

  // Trace: prepend a "delegated" marker per specialist the orchestrator routed
  // to, then the executed/proposed tool calls. Empty in single-specialist mode.
  const toolTrace = [
    ...delegations.map((d) => ({ tool: `→ ${d.label}`, ok: true, status: "delegated" as const })),
    ...outcomes.map((o) => ({
      tool: o.toolName,
      ok: o.ok,
      status: o.status,
      proposalId: o.proposalId,
      recordId: o.recordId,
    })),
  ];

  if (airtableEnabled(ctx)) {
    await core.create(ctx.orgSlug, "CHAT_MESSAGES", {
      Session_Id: String(sessionId),
      Role: "assistant",
      Content: reply || "(no reply)",
      Tool_Calls: JSON.stringify(toolTrace),
      Created_At: new Date().toISOString(),
    });
    await core
      .create(ctx.orgSlug, "EXECUTION_LOG", {
        Log_Entry: "chat",
        Action_Type: "chat",
        Tables_Affected: "CHAT_MESSAGES",
        Summary: JSON.stringify({ user: userName, tools: outcomes.length, demoMode, ...timing }),
        Initiated_By: "AI",
        Status: "executed",
        Date_Time: new Date().toISOString(),
      })
      .catch(() => {});
  } else {
    await db(ctx).platChatMessage.create({
      data: {
        orgId: ctx.orgId,
        sessionId: Number(sessionId),
        role: "assistant",
        content: reply || "(no reply)",
        toolCalls: JSON.stringify(toolTrace),
      },
    });
    await db(ctx).platExecutionLog
      .create({
        data: {
          orgId: ctx.orgId,
          jobId: typeof opts.jobId === "number" ? opts.jobId : undefined,
          actorType: "ai",
          actorName: ctx.config.assistant.name,
          operation: "chat",
          targetTable: "plat_core_chatmessage",
          payload: JSON.stringify({ user: userName, tools: outcomes.length, demoMode, ...timing }),
          status: "executed",
          executedAt: new Date(),
          sourceMessageId: userMsgId,
          promptVersion: version,
        },
      })
      .catch(() => {});
  }

  return { sessionId, reply, demoMode, outcomes, pendingApprovals };
}
