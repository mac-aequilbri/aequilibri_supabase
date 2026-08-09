// Orchestrator (Module 7, Conversational Assistant) — the supervisor that
// routes a user turn to the right specialist agent(s) via "agents-as-tools":
// its only tool is `delegate`, whose execution runs the chosen specialist's own
// tool-use loop and feeds the result back. All specialist writes still go
// through the shared executor + aiAuthority gate — the orchestrator adds
// routing, never a private write path.
//
// Cost note: when only one specialist is available the orchestrator
// short-circuits straight to it (no extra model call). The delegation model
// call is only spent once routing is genuinely a choice (2+ specialists). A
// lone delegation with no orchestrator prose is relayed verbatim (no synthesis
// round). Specialists it delegates to may themselves delegate once more, bounded
// by MAX_AGENT_DELEGATION_DEPTH.

import type Anthropic from "@anthropic-ai/sdk";
import { callClaudeConversation, type ChatStreamEvent } from "@/lib/claude";
import { modelFor } from "@/lib/platform/modelRouter";
import { getPrompt } from "@/lib/platform/prompts";
import { Actor, OrgCtx } from "@/lib/platform/types";
import type { ToolOutcome } from "@/services/platform/assistant/executor";
import { MAX_AGENT_DELEGATION_DEPTH, buildDelegateTool, runAgentLoop } from "./loop";
import type { AgentViewer, DelegationContext, Specialist } from "./types";

export type { Specialist } from "./types";
export { buildDelegateTool } from "./loop";

const MAX_DELEGATION_ROUNDS = 3;

export interface DelegationTrace {
  agent: string;
  label: string;
}

export interface OrchestratorResult {
  reply: string;
  demoMode: boolean;
  outcomes: ToolOutcome[];
  delegations: DelegationTrace[];
}

async function delegateToSpecialist(
  target: Specialist,
  ctx: OrgCtx,
  convo: Anthropic.MessageParam[],
  actor: Actor,
  task: string,
  userRole: string | undefined,
  delegation: DelegationContext,
  onEvent?: (e: ChatStreamEvent) => void,
  viewer?: AgentViewer,
): Promise<{ reply: string; outcomes: ToolOutcome[] }> {
  // The specialist answers the real conversation (full context); the routing
  // task is added as a hint so it knows why it was picked.
  const system = task
    ? `${target.system}\n\nThe coordinator routed this request to you: ${task}`
    : target.system;
  const sub = await runAgentLoop(target.agent, ctx, system, [...convo], actor, userRole, delegation, onEvent, viewer);
  return { reply: sub.reply || "(the specialist returned no reply)", outcomes: sub.outcomes };
}

export async function runOrchestrator(
  ctx: OrgCtx,
  convo: Anthropic.MessageParam[],
  actor: Actor,
  opts: {
    specialists: Specialist[];
    orgName: string;
    userRole?: string;
    onEvent?: (e: ChatStreamEvent) => void;
    /** The chat viewer's identity for the agents' MCP sessions (plan W5). */
    viewer?: AgentViewer;
  },
): Promise<OrchestratorResult> {
  const { specialists, orgName, userRole, onEvent, viewer } = opts;

  // No routing choice to make — run the one specialist directly.
  if (specialists.length <= 1) {
    const only = specialists[0];
    if (!only) return { reply: "No assistant is configured.", demoMode: false, outcomes: [], delegations: [] };
    const r = await runAgentLoop(only.agent, ctx, only.system, convo, actor, userRole, undefined, onEvent, viewer);
    return { reply: r.reply, demoMode: r.demoMode, outcomes: r.outcomes, delegations: [] };
  }

  const byKey = new Map<string, Specialist>(specialists.map((s) => [s.agent.key, s]));
  const { system } = getPrompt("assistant.orchestrator", {
    orgName,
    specialists: specialists.map((s) => `- ${s.agent.key}: ${s.agent.label} — ${s.agent.description}`).join("\n"),
  });
  const delegateTool = buildDelegateTool(specialists);
  // Specialists reached from here start at depth 1 and may delegate once more.
  const delegation: DelegationContext = { specialists, byKey, depth: 1, maxDepth: MAX_AGENT_DELEGATION_DEPTH };

  const oconvo: Anthropic.MessageParam[] = [...convo];
  const outcomes: ToolOutcome[] = [];
  const delegations: DelegationTrace[] = [];
  let reply = "";
  let demoMode = false;
  let lastSpecialistReply: string | null = null;

  for (let round = 0; round <= MAX_DELEGATION_ROUNDS; round++) {
    const res = await callClaudeConversation(system, oconvo, {
      tools: [delegateTool],
      maxTokens: 1500,
      // The coordinator only routes (delegate tool) and stitches specialist
      // replies together — a classification/routing job, not domain reasoning.
      // Run it on the cheaper/faster tier; specialists stay on the chat model.
      model: modelFor("classification"),
      onEvent,
    });
    demoMode = res.demo_mode;
    if (res.demo_mode || res.tool_uses.length === 0 || round === MAX_DELEGATION_ROUNDS) {
      reply = res.content;
      break;
    }

    const assistantBlocks: Anthropic.ContentBlockParam[] = [];
    if (res.content.trim()) assistantBlocks.push({ type: "text", text: res.content });
    const resultBlocks: Anthropic.ContentBlockParam[] = [];
    for (const tu of res.tool_uses) {
      if (!tu.id) continue;
      assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input ?? {} });
      const input = (tu.input ?? {}) as Record<string, unknown>;
      const target = byKey.get(String(input.agent ?? ""));
      if (tu.name !== "delegate" || !target) {
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `Unknown specialist "${String(input.agent ?? "")}". Choose one of: ${specialists.map((s) => s.agent.key).join(", ")}.`,
          is_error: true,
        });
        continue;
      }
      const sub = await delegateToSpecialist(target, ctx, convo, actor, String(input.task ?? ""), userRole, delegation, onEvent, viewer);
      outcomes.push(...sub.outcomes);
      delegations.push({ agent: target.agent.key, label: target.agent.label });
      lastSpecialistReply = sub.reply;
      resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: sub.reply, is_error: false });
    }
    if (!resultBlocks.length) {
      reply = res.content;
      break;
    }
    // Cost guard: a single delegation with no orchestrator prose of its own
    // needs no synthesis round — relay the specialist's reply verbatim.
    if (delegations.length === 1 && lastSpecialistReply !== null && !res.content.trim()) {
      reply = lastSpecialistReply;
      break;
    }
    oconvo.push({ role: "assistant", content: assistantBlocks });
    oconvo.push({ role: "user", content: resultBlocks });
  }

  return { reply, demoMode, outcomes, delegations };
}
