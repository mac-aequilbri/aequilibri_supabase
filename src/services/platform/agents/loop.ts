// Generic agent tool-use loop — extracted from the assistant's sendChatMessage.
// Runs any AgentDefinition: calls the model with the agent's tools, executes
// each tool_use through the in-process MCP client (mcp-assistant-plan W5) —
// the same server core external MCP consumers hit, which shims into the
// shared executor (org aiAuthority + role policy) — feeds tool_result blocks
// back, and repeats until the model stops calling tools or MAX_TOOL_ROUNDS.
//
// Inter-agent delegation: when a DelegationContext is supplied and the depth cap
// isn't reached, the agent is also given a `delegate` tool; handling it recurses
// into the target specialist's own loop (depth + 1). The depth cap bounds the
// recursion so agents can't loop on each other.

import type Anthropic from "@anthropic-ai/sdk";
import { callClaudeConversation, type ChatStreamEvent } from "@/lib/claude";
import type { ToolContract } from "@/lib/platform/toolContract";
import { modelFor } from "@/lib/platform/modelRouter";
import { Actor, OrgCtx } from "@/lib/platform/types";
import type { ToolOutcome } from "@/services/platform/assistant/executor";
import { executeToolViaMcp } from "@/services/platform/mcp/client";
import type { McpSession } from "@/services/platform/mcp/session";
import type { AgentDefinition, AgentViewer, DelegationContext, Specialist } from "./types";

// Enough rounds to discover a table, read it, page it and follow up on one
// record — the shape a grounded answer actually takes. At 4 the loop ran out
// mid-investigation and the model answered from what it had.
export const MAX_TOOL_ROUNDS = 8;
/** Per-call output ceiling. 1500 truncated real answers mid-sentence; this is
 *  the SDK's recommended non-streaming default. */
export const AGENT_MAX_TOKENS = 16000;
/** The orchestrator delegates at depth 1; a specialist may delegate once more
 *  (depth 2), then delegation stops — bounds inter-agent recursion. */
export const MAX_AGENT_DELEGATION_DEPTH = 2;

export interface AgentLoopResult {
  reply: string;
  demoMode: boolean;
  outcomes: ToolOutcome[];
}

/** The delegate tool offered to an agent — an enum of the specialists it may
 *  hand off to. Shared by the orchestrator and inter-agent delegation. */
export function buildDelegateTool(specialists: Specialist[]): ToolContract {
  return {
    name: "delegate",
    description:
      "Hand the request to the specialist agent best suited to it, then use its result to answer.",
    input_schema: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          enum: specialists.map((s) => s.agent.key),
          description: "Which specialist to hand this to.",
        },
        task: { type: "string", description: "A concise instruction for the specialist." },
      },
      required: ["agent", "task"],
    },
  };
}

/** Specialists an agent may delegate to right now — excludes itself, and is
 *  empty once the delegation depth cap is reached (prevents runaway chains). */
export function delegationTargets(agentKey: string, delegation?: DelegationContext): Specialist[] {
  if (!delegation || delegation.depth >= delegation.maxDepth) return [];
  return delegation.specialists.filter((s) => s.agent.key !== agentKey);
}

export async function runAgentLoop(
  agent: AgentDefinition,
  ctx: OrgCtx,
  system: string,
  convo: Anthropic.MessageParam[],
  actor: Actor,
  userRole?: string,
  delegation?: DelegationContext,
  onEvent?: (e: ChatStreamEvent) => void,
  viewer?: AgentViewer,
): Promise<AgentLoopResult> {
  const outcomes: ToolOutcome[] = [];
  let reply = "";
  let demoMode = false;

  const targets = delegationTargets(agent.key, delegation);
  const tools = targets.length ? [...agent.tools, buildDelegateTool(targets)] : agent.tools;

  // The agent's MCP session (plan W5): the chat viewer's identity for role
  // gates + RLS, pinned to this agent's tool bundle, with the chat actor for
  // write provenance. Without a viewer (offline tests / demo turns) the
  // session still gates on userRole; RLS then resolves fail-open exactly as
  // the pre-W5 demo path did.
  const session: McpSession = {
    ctx,
    user: viewer ?? { name: actor.name, email: "", role: userRole ?? "" },
    platformAdmin: viewer?.platformAdmin === true,
    tools: Object.keys(agent.toolPolicy),
    actor,
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const res = await callClaudeConversation(system, convo, {
      tools,
      maxTokens: AGENT_MAX_TOKENS,
      model: modelFor(agent.modelTask),
      onEvent,
    });
    demoMode = res.demo_mode;
    if (res.demo_mode || res.tool_uses.length === 0 || round === MAX_TOOL_ROUNDS) {
      reply = res.content;
      break;
    }

    // Echo the assistant turn (text + tool_use blocks), then answer each
    // tool_use with a tool_result so the model can continue.
    const assistantBlocks: Anthropic.ContentBlockParam[] = [];
    if (res.content.trim()) assistantBlocks.push({ type: "text", text: res.content });
    const resultBlocks: Anthropic.ContentBlockParam[] = [];
    for (const tu of res.tool_uses) {
      if (!tu.id) continue;
      assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input ?? {} });

      // Inter-agent delegation — a specialist handing off to another specialist.
      if (tu.name === "delegate" && delegation) {
        const input = (tu.input ?? {}) as Record<string, unknown>;
        const target = delegation.byKey.get(String(input.agent ?? ""));
        if (!target || target.agent.key === agent.key) {
          resultBlocks.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: `Cannot delegate to "${String(input.agent ?? "")}".`,
            is_error: true,
          });
          continue;
        }
        const task = String(input.task ?? "");
        const subSystem = task
          ? `${target.system}\n\nRouted from the ${agent.label} agent: ${task}`
          : target.system;
        const sub = await runAgentLoop(
          target.agent,
          ctx,
          subSystem,
          [...convo],
          actor,
          userRole,
          { ...delegation, depth: delegation.depth + 1 },
          onEvent,
          viewer,
        );
        outcomes.push(...sub.outcomes);
        resultBlocks.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: sub.reply || "(the specialist returned no reply)",
          is_error: false,
        });
        continue;
      }

      const outcome = await executeToolViaMcp(session, tu);
      outcomes.push(outcome);
      resultBlocks.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: outcome.summary,
        is_error: !outcome.ok,
      });
    }
    if (!resultBlocks.length) {
      reply = res.content;
      break;
    }
    convo.push({ role: "assistant", content: assistantBlocks });
    convo.push({ role: "user", content: resultBlocks });
  }

  return { reply, demoMode, outcomes };
}
