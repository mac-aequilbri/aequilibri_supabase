import type Anthropic from "@anthropic-ai/sdk";
import type { ChatStreamEvent } from "@/lib/claude";
import { db } from "@/lib/db";
import { normalizeTeamRole } from "@/lib/platform/module1Governance";
import { isPlatformAdmin } from "@/lib/platform/org-context";
import { getPrompt } from "@/lib/platform/prompts";
import { Actor, OrgCtx } from "@/lib/platform/types";
import type { RecordId } from "@/lib/platform/recordWriter";
import { domainVocabBlock } from "@/lib/platform/domainLabels";
import { learningPromptText } from "../learning";
import { jobContextBlock } from "./context";
import { catalogPromptLine } from "./dataCatalog";
import type { ToolOutcome } from "./executor";
import { runOrchestrator, type Specialist } from "../agents/orchestrator";
import { SPECIALISTS } from "../agents/registry";
import { currentJobScope } from "@/lib/platform/rls";

const HISTORY_LIMIT = 20;

/** How many recent assistant turns replay the data their tools returned.
 *  Persisting only the final prose meant every follow-up question ("and the
 *  other supplier?") started from nothing and had to re-read — or, worse, was
 *  answered from the model's memory of a summary. */
const REPLAY_TOOL_DATA_TURNS = 3;
/** Per-turn ceiling on replayed tool output. */
const REPLAY_TOOL_DATA_CHARS = 6000;

interface PersistedToolCall {
  tool?: string;
  result?: string;
}

/** Rebuild an assistant turn's retrieved data from its persisted tool trace,
 *  as a plainly-labelled appendix the model can read but the UI never renders
 *  (the trace lives in `toolCalls`, not in the displayed `content`). */
function retrievedDataBlock(toolCalls: string): string {
  if (!toolCalls) return "";
  let parsed: PersistedToolCall[];
  try {
    parsed = JSON.parse(toolCalls) as PersistedToolCall[];
  } catch {
    return "";
  }
  const withData = (Array.isArray(parsed) ? parsed : []).filter((c) => c?.result);
  if (!withData.length) return "";
  let budget = REPLAY_TOOL_DATA_CHARS;
  const parts: string[] = [];
  for (const c of withData) {
    if (budget <= 0) break;
    const body = c.result!.slice(0, budget);
    budget -= body.length;
    parts.push(`${c.tool}: ${body}`);
  }
  return `\n\n[Data you retrieved on this turn — reuse it instead of re-reading:\n${parts.join("\n")}]`;
}

interface ChatMessageRow {
  id: RecordId;
  role: string;
  content: string;
  toolCalls: string;
  createdAt: Date;
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
  const session = await db(ctx).platChatSession.create({ data: { orgId: ctx.orgId, title: encoded } });
  return session.id;
}

/** Rename a standalone conversation (used for first-message auto-titling). */
export async function renameChatSession(ctx: OrgCtx, sessionId: RecordId, title: string): Promise<void> {
  const encoded = encodeChatTitle(title);
  await db(ctx).platChatSession.updateMany({
    where: { id: Number(sessionId), orgId: ctx.orgId },
    data: { title: encoded },
  });
}

/** Permanently delete a standalone conversation and its messages. Callers must
 *  first confirm the id belongs to this org's standalone set (isChatSession). */
export async function deleteChatSession(ctx: OrgCtx, sessionId: RecordId): Promise<void> {
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
  // The Postgres store has never persisted the close review (the summary stamp
  // and session-close EXECUTION_LOG entry were Airtable-only); the parameter is
  // kept so callers' signatures are unchanged.
  void close;
  await db(ctx).platChatSession.updateMany({
    where: { id: Number(sessionId), orgId: ctx.orgId },
    data: { endedAt: new Date() },
  });
}

export async function listMessages(ctx: OrgCtx, sessionId: RecordId): Promise<ChatMessageRow[]> {
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
 *  (and org-global rows), never the whole org's projects/counts.
 *
 *  The row-count map is the important half: it is what a Claude session
 *  connected to Airtable gets for free from `list_tables`. Without it the model
 *  has no idea a table has 274 rows rather than 4, so it neither pages nor
 *  hedges — it just answers from whatever the first read returned. */
async function dataContext(ctx: OrgCtx): Promise<string> {
  const scope = await currentJobScope(ctx);
  const ids = scope.mode === "some" ? [...scope.jobIds].map(Number).filter((n) => Number.isFinite(n)) : null;
  const jobW = ids ? { jobId: { in: ids } } : scope.mode === "none" ? { jobId: -1 } : {};
  const ownW = ids ? { id: { in: ids } } : scope.mode === "none" ? { id: -1 } : {};
  const org = { orgId: ctx.orgId };
  const d = db(ctx);

  const [jobs, counts, openActions, pendingProposals] = await Promise.all([
    d.platJob.findMany({
      where: { ...org, ...ownW },
      select: {
        id: true,
        code: true,
        name: true,
        engagementType: true,
        status: true,
        completionPct: true,
        budgetTotal: true,
      },
      take: 25,
      orderBy: { updatedAt: "desc" },
    }),
    // One count per table the assistant is most often asked about. Cheap
    // indexed counts; the full surface is discoverable via describe_data.
    Promise.all([
      d.platActionHub.count({ where: { ...org, ...jobW } }).then((n) => ["actions", n] as const),
      d.platDecision.count({ where: { ...org, ...jobW } }).then((n) => ["decisions", n] as const),
      d.platConPhase.count({ where: { ...org, ...jobW } }).then((n) => ["phases", n] as const),
      d.platConPlanTask.count({ where: { ...org, ...jobW } }).then((n) => ["plan", n] as const),
      d.platConBudgetLine.count({ where: { ...org, ...jobW } }).then((n) => ["budget_lines", n] as const),
      d.platConCashflowLedger.count({ where: { ...org, ...jobW } }).then((n) => ["cashflows", n] as const),
      d.platConProcurement.count({ where: { ...org, ...jobW } }).then((n) => ["procurement", n] as const),
      d.platConRisk.count({ where: { ...org, ...jobW } }).then((n) => ["risks", n] as const),
      d.platDocument.count({ where: { ...org, ...jobW } }).then((n) => ["documents", n] as const),
      d.platConRoomMatrix.count({ where: { ...org, ...jobW } }).then((n) => ["rooms", n] as const),
      d.platConVendor.count({ where: org }).then((n) => ["vendors", n] as const),
      d.platContact.count({ where: org }).then((n) => ["contacts", n] as const),
    ]),
    d.platActionHub.count({ where: { ...org, ...jobW, status: { in: ["open", "in_progress"] } } }),
    d.platPendingWrite.count({ where: { ...org, ...jobW, status: "proposed" } }),
  ]);

  return [
    `Jobs (${jobs.length}): ${JSON.stringify(jobs, (_k, v) => (typeof v === "bigint" ? Number(v) : v))}`,
    `Row counts in your scope: ${JSON.stringify(Object.fromEntries(counts))}`,
    `Open actions: ${openActions}. Pending write proposals awaiting human approval: ${pendingProposals}.`,
    `These counts are the truth about how much data exists. If a read returns fewer rows than the count above, you are looking at a page — page through it before summarising.`,
  ].join("\n");
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
    /** The viewer's email — identifies the member for the agents' MCP
     *  sessions (plan W5: role gates + RLS run on this identity, resolved at
     *  the request edge, never inside the loop). */
    userEmail?: string;
    onEvent?: (e: ChatStreamEvent) => void;
  } = {},
): Promise<SendResult> {
  const startedAt = Date.now();
  const sessionId = opts.sessionId ?? (await getOrCreateSession(ctx, opts.jobId));
  const userMsg = await db(ctx).platChatMessage.create({
    data: { orgId: ctx.orgId, sessionId: Number(sessionId), role: "user", content: text },
  });
  const userMsgId: number = userMsg.id;

  const readsAt = Date.now();
  const [rulesBlock, context, sessionContext, vocabBlock, historyRows] = await Promise.all([
    learningPromptText(ctx),
    dataContext(ctx),
    // Spec 12 Module 7 context loading (lock plan §7.1): phases+RAG, budget
    // summary (finance-visible roles), issue counts, recent decisions and
    // activity — TTL-cached, invalidated by every write through recordWriter.
    jobContextBlock(ctx, { jobId: opts.jobId, role: opts.userRole }),
    domainVocabBlock(ctx),
    db(ctx).platChatMessage.findMany({
      where: { orgId: ctx.orgId, sessionId: Number(sessionId), id: { lt: userMsgId } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
    }),
  ]);
  const readMs = Date.now() - readsAt;

  const { system, version } = getPrompt("assistant.chat", {
    persona: ctx.config.assistant.persona,
    orgName: ctx.orgName,
    // Without this the assistant has no idea what "today" is, so every
    // "overdue" / "this week" / "due soon" answer is a guess.
    today: new Date().toISOString().slice(0, 10),
    tables: catalogPromptLine(),
    jobLine: opts.jobId ? ` (current job id ${opts.jobId})` : "",
    rulesBlock: [
      rulesBlock,
      sessionContext,
      vocabBlock,
      `Current user role: ${normalizeTeamRole(opts.userRole ?? "broker")}.`,
      `Role access is enforced server-side: owner has full access; builder writes actions/workstreams only (no budget, risks, decisions, or rules); architect additionally drafts variations but has no financial access; broker is read-only except raising an action to flag a decision needed. Financial tables (budget, cashflow) and learning rules are readable by the owner only — for other roles, answer without that data and note it is owner-restricted.`,
      `Current data snapshot:\n${context}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  const replayable = historyRows
    .reverse()
    .filter((m) => m.role === "user" || m.role === "assistant");
  // Only the most recent turns carry their retrieved data forward — enough for
  // "and what about the other one?" to resolve, bounded so a long thread of
  // large reads can't crowd out the system prompt.
  const carryFrom = Math.max(0, replayable.length - REPLAY_TOOL_DATA_TURNS * 2);
  const convo: Anthropic.MessageParam[] = [
    ...replayable.map((m, i) => ({
      role: m.role as "user" | "assistant",
      content:
        (m.content || "…") + (i >= carryFrom ? retrievedDataBlock(m.toolCalls) : ""),
    })),
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
    // The agents' MCP sessions act as this viewer (plan W5).
    viewer: {
      name: userName,
      email: opts.userEmail ?? "",
      role: opts.userRole ?? "",
      platformAdmin,
    },
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
  // The returned rows ride along so the next turn can reason about them (see
  // retrievedDataBlock) instead of re-reading or answering from memory. Shared
  // budget across the turn's calls so a wide read can't bloat the row; the UI
  // reads only `tool`/`ok`/`status` and ignores `result`.
  let traceBudget = REPLAY_TOOL_DATA_CHARS;
  const toolTrace = [
    ...delegations.map((d) => ({ tool: `→ ${d.label}`, ok: true, status: "delegated" as const })),
    ...outcomes.map((o) => {
      const result = o.ok && traceBudget > 0 ? o.summary.slice(0, traceBudget) : undefined;
      if (result) traceBudget -= result.length;
      return {
        tool: o.toolName,
        ok: o.ok,
        status: o.status,
        proposalId: o.proposalId,
        recordId: o.recordId,
        result,
      };
    }),
  ];

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

  return { sessionId, reply, demoMode, outcomes, pendingApprovals };
}
