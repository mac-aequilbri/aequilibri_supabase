// Learning Loop agent (Module 6) — turns durable guidance from the
// conversation into proposed learning rules the assistant must follow in future
// sessions. Rule proposals are high-risk and always require human approval
// (enforced by the shared authority gate, not this agent).

import { policyByName, toolsByName } from "@/services/platform/assistant/tools";
import type { AgentDefinition } from "./types";

const TOOLS = ["query_records", "describe_data", "get_record", "propose_rule"] as const;

export const learningLoopAgent: AgentDefinition = {
  key: "learning_loop",
  module: 6,
  label: "Learning Loop",
  description:
    "Captures durable guidance as proposed learning rules (guidance the assistant follows in future sessions). Every rule proposal requires human approval.",
  systemPromptId: "assistant.chat",
  tools: toolsByName(TOOLS),
  toolPolicy: policyByName(TOOLS),
  modelTask: "chat",
};
