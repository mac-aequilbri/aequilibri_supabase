// Multi-agent core — an AgentDefinition is a self-contained agent unit: its
// own prompt, tool bundle, per-tool authority policy, and model tier. The
// generic loop (agents/loop.ts) runs any AgentDefinition; the registry
// (agents/registry.ts) names them. Phase 0 extracts this abstraction from the
// single hardcoded assistant with no behaviour change — the existing assistant
// is now just the `project_intelligence` entry.

import type { AiTask } from "@/lib/platform/modelRouter";
import type { ToolContract } from "@/lib/platform/toolContract";
import type { ToolPolicy } from "@/services/platform/assistant/tools";

/** Registered agent keys. New module-agents extend this union. */
export type AgentKey =
  | "onboarding"
  | "ingestion"
  | "assessment"
  | "document"
  | "project_intelligence"
  | "learning_loop"
  | "reporting";

export interface AgentDefinition {
  key: AgentKey;
  /** Platform module number this agent embodies (1..8). */
  module: number;
  /** Human-readable label for traces/logs. */
  label: string;
  /** One-line "what this agent handles" — shown to the orchestrator so it can
   *  route requests to the right specialist. */
  description: string;
  /** Prompt template id resolved via src/lib/platform/prompts. */
  systemPromptId: string;
  /** Tools the model may call in this agent's loop. */
  tools: ToolContract[];
  /** Per-tool risk/table/op policy, keyed by tool name. */
  toolPolicy: Record<string, ToolPolicy>;
  /** modelRouter task used to resolve the concrete model id at call time. */
  modelTask: AiTask;
}

/** A specialist made available for delegation, with its resolved system prompt. */
export interface Specialist {
  agent: AgentDefinition;
  system: string;
}

/** The chat viewer an agent loop acts for (plan W5): identity for the MCP
 *  session — role gates + RLS scope on their membership, platformAdmin for
 *  operator tools. Resolved at the request edge (org-context) and threaded
 *  down; the loop never consults the request context itself. */
export interface AgentViewer {
  name: string;
  email: string;
  role: string;
  platformAdmin?: boolean;
}

/** Passed down a runAgentLoop chain so a specialist can delegate to another.
 *  `depth` increments each hop; delegation stops once it reaches `maxDepth`,
 *  which bounds inter-agent recursion. */
export interface DelegationContext {
  specialists: Specialist[];
  byKey: Map<string, Specialist>;
  depth: number;
  maxDepth: number;
}
