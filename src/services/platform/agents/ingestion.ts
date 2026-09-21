// Data Ingestion agent (Module 2) — the entry point for incoming source
// material. Given raw text and its classification it suggests how the source
// should be routed into the system (cashflow, procurement, decision, action).
// Read-only: it proposes routes; the user (or Project Intelligence) commits them
// through the normal gated write tools.

import { policyByName, toolsByName } from "@/services/platform/assistant/tools";
import type { AgentDefinition } from "./types";

const TOOLS = ["query_records", "describe_data", "get_record", "suggest_ingestion_routes"] as const;

export const ingestionAgent: AgentDefinition = {
  key: "ingestion",
  module: 2,
  label: "Data Ingestion",
  description:
    "Handles incoming source material (documents, emails): suggests how a source should be routed into the system — cashflow, procurement, decisions or actions. Proposes routes only; writing them is done via the normal gated tools.",
  systemPromptId: "assistant.chat",
  tools: toolsByName(TOOLS),
  toolPolicy: policyByName(TOOLS),
  modelTask: "chat",
};
