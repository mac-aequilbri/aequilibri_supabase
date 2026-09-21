// Reporting agent (Module 8) — produces client-facing outputs. Drafts weekly
// project reports from live job data; the draft enters the report's
// draft→approved→sent lifecycle, so a human approves before anything is sent.

import { policyByName, toolsByName } from "@/services/platform/assistant/tools";
import type { AgentDefinition } from "./types";

const TOOLS = ["query_records", "describe_data", "get_record", "generate_weekly_report"] as const;

export const reportingAgent: AgentDefinition = {
  key: "reporting",
  module: 8,
  label: "Reporting",
  description:
    "Produces client-facing reporting: drafts weekly project reports from live job data (progress, budget, risks, next week) for human approval before sending.",
  systemPromptId: "assistant.chat",
  tools: toolsByName(TOOLS),
  toolPolicy: policyByName(TOOLS),
  modelTask: "chat",
};
