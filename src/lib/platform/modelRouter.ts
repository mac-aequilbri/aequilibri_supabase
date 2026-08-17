// Model router — the one place model selection lives (Platform Architecture
// doc: Haiku for classification/routing, Sonnet default, Opus gated for
// complex analysis). Override per task type via PLATFORM_MODEL_<TASK> env vars.

export type AiTask =
  | "classification"
  | "extraction"
  | "chat"
  | "drafting"
  | "vision"
  | "complex_reasoning";

const MODEL_BY_TASK: Record<AiTask, string> = {
  classification: "claude-haiku-4-5",
  extraction: "claude-sonnet-5",
  // The assistant's answering tier. A client comparing us against their own
  // Claude session is comparing against Opus — running the specialists a tier
  // (and a generation) below shows up as "the chat assistant is worse", so
  // chat matches what they'd get talking to Claude directly. Override per
  // environment with PLATFORM_MODEL_CHAT if cost needs trading against it.
  chat: "claude-opus-5",
  drafting: "claude-sonnet-5",
  vision: "claude-sonnet-5",
  complex_reasoning: "claude-opus-5",
};

export function modelFor(task: AiTask): string {
  const override = process.env[`PLATFORM_MODEL_${task.toUpperCase()}`];
  return override || MODEL_BY_TASK[task];
}
