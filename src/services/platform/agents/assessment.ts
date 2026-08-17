// Assessment agent (Module 3) — the Assessment Engine surfaced in chat. Runs a
// construction intake assessment (data cascade → AI analysis → learning rules →
// structured budget/phases/risks with confidence) and drafts it for human
// review; a job is only created when the draft is accepted downstream.

import { policyByName, toolsByName } from "@/services/platform/assistant/tools";
import type { AgentDefinition } from "./types";

const TOOLS = ["query_records", "describe_data", "get_record", "run_construction_intake"] as const;

export const assessmentAgent: AgentDefinition = {
  key: "assessment",
  module: 3,
  label: "Assessment Engine",
  description:
    "Runs intake assessments: from scope, address and size it drafts a budget, phase plan and risks with a confidence score for a prospective job, for human review before the job is created.",
  systemPromptId: "assistant.chat",
  tools: toolsByName(TOOLS),
  toolPolicy: policyByName(TOOLS),
  modelTask: "chat",
};
