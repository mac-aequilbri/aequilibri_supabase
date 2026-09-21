// Project Intelligence agent (Module 5) — manages the live engagement: the
// action hub, decisions, risk register, budget, variations, phases and
// workstreams. Its tools are the engagement-write subset of the shared
// definitions; the learning-rule and document-capture tools now belong to the
// Learning Loop and Document agents respectively.

import { policyByName, toolsByName } from "@/services/platform/assistant/tools";
import type { AgentDefinition } from "./types";

const TOOLS = [
  "query_records",
  "describe_data",
  "get_record",
  "propose_create",
  "propose_update",
  "propose_delete",
  "create_action",
  "update_action",
  "save_decision",
  "create_risk",
  "update_budget_line",
  "create_variation_draft",
  // Spec 12 Module 5 COMMS / Module 7 send_email path (lock plan §7.2):
  // always approval-gated; n8n delivers on approval.
  "draft_comm",
  "log_workstream_update",
] as const;

export const projectIntelligenceAgent: AgentDefinition = {
  key: "project_intelligence",
  module: 5,
  label: "Project Intelligence",
  description:
    "Runs the live engagement: action items, decisions, risks, budget lines, variations, phases and workstream updates. Reads any project data and proposes record changes.",
  systemPromptId: "assistant.chat",
  tools: toolsByName(TOOLS),
  toolPolicy: policyByName(TOOLS),
  modelTask: "chat",
};
