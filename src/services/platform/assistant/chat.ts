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
import type { ToolOutcome } from "./executor";
import { runOrchestrator, type Specialist } from "../agents/orchestrator";
import { SPECIALISTS } from "../agents/registry";
import { currentJobScope } from "@/lib/platform/rls";

const HISTORY_LIMIT = 20;

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
 *  (and org-global rows), never the whole org's projects/counts. */
async function dataContext(ctx: OrgCtx): Promise<string> {
  const scope = await currentJobScope(ctx);
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
