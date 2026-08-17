// Onboarding agent (Module 1) — Customer Onboarding Engine, surfaced in chat
// for platform operators. It reports an org's Day-1 configuration readiness and
// helps capture initial domain knowledge (delegating rule creation to the
// Learning Loop agent). Live org/base provisioning deliberately stays in the
// /app/new form — it is cross-org and creates external Airtable resources, so it
// is not a chat tool. This agent is only offered to platform admins (filtered in
// chat.ts and re-checked in the executor's onboarding_status handler).

import { policyByName, toolsByName } from "@/services/platform/assistant/tools";
import type { AgentDefinition } from "./types";

const TOOLS = ["query_records", "describe_data", "get_record", "onboarding_status"] as const;

export const onboardingAgent: AgentDefinition = {
  key: "onboarding",
  module: 1,
  label: "Onboarding",
  description:
    "Sets up and inspects a customer instance: reports the organisation's Day-1 configuration readiness (features, engagement types, AI authority, seeded knowledge) and helps capture initial domain guidance. Platform-admin only.",
  systemPromptId: "assistant.chat",
  tools: toolsByName(TOOLS),
  toolPolicy: policyByName(TOOLS),
  modelTask: "chat",
};
