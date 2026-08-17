// Document agent (Module 4) — preserves source material from the conversation
// (call summaries, pasted notes, key context) as persistent, traceable
// documents so it survives the session. Uses the existing capture tool; the
// wider Document Management surface (classify/analyze/version) lands in Phase 3.

import { policyByName, toolsByName } from "@/services/platform/assistant/tools";
import type { AgentDefinition } from "./types";

const TOOLS = ["query_records", "describe_data", "get_record", "capture_source_note"] as const;

export const documentAgent: AgentDefinition = {
  key: "document",
  module: 4,
  label: "Document Management",
  description:
    "Captures important source material and notes from the conversation as persistent, traceable documents.",
  systemPromptId: "assistant.chat",
  tools: toolsByName(TOOLS),
  toolPolicy: policyByName(TOOLS),
  modelTask: "chat",
};
