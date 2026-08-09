// Shared Claude client — port of core/claude_client.py.
// If ANTHROPIC_API_KEY is set, calls the real model; otherwise returns the
// same demo/simulated responses as the Django app (parity for offline dev).

import Anthropic from "@anthropic-ai/sdk";
import { logger, errMeta } from "@/lib/logger";
import type { ToolContract } from "@/lib/platform/toolContract";

// Env-overridable so a model rollover is a config change, not a deploy.
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-7"; // matches the Django client

function getApiKey(): string {
  return process.env.ANTHROPIC_API_KEY ?? "";
}

// Singleton with an explicit timeout: the SDK default is ~10 minutes, longer
// than any route budget (maxDuration=300), so a hung upstream call would pin
// the request until the platform killed it. maxRetries made explicit.
let anthropicClient: Anthropic | null = null;
function getClient(apiKey: string): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey, timeout: 180_000, maxRetries: 2 });
  }
  return anthropicClient;
}

export interface VisionResult {
  content: string;
  demo_mode: boolean;
}

export interface VisionImage {
  b64: string;
  media_type?: string;
  label?: string;
}

export interface ToolUse {
  name: string;
  input: unknown;
  /** Block id from the API — needed to send tool_result blocks back. */
  id?: string;
}

export interface ChatResult {
  content: string;
  tool_uses: ToolUse[];
  demo_mode: boolean;
}

/** Incremental output for streamed chat turns. `reset` marks the start of a new
 *  model call (the client discards any prior deltas), so only the final
 *  answer's text survives across an orchestrator's multi-call fan-out. */
export type ChatStreamEvent = { type: "reset" } | { type: "delta"; text: string };

function textFrom(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function parseBlocks(content: Anthropic.ContentBlock[]): { content: string; tool_uses: ToolUse[] } {
  const textParts: string[] = [];
  const toolUses: ToolUse[] = [];
  for (const block of content) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "tool_use")
      toolUses.push({ name: block.name, input: block.input, id: block.id });
  }
  return { content: textParts.join("\n"), tool_uses: toolUses };
}

/** Single base64 image + text prompt. Pass temperature=0 for deterministic output. */
export async function callClaudeVision(
  systemPrompt: string,
  userText: string,
  imageB64: string,
  opts: { mediaType?: string; maxTokens?: number; temperature?: number | null; model?: string } = {},
): Promise<VisionResult> {
  const { mediaType = "image/png", maxTokens = 2048, temperature = null, model = MODEL } = opts;
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      content: '{"sections":[],"notes":"Demo mode — no API key","confidence":"low"}',
      demo_mode: true,
    };
  }
  try {
    const client = getClient(apiKey);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
                data: imageB64,
              },
            },
            { type: "text", text: userText },
          ],
        },
      ],
    };
    if (temperature !== null) params.temperature = temperature;
    const response = await client.messages.create(params);
    logUsage("vision", model, response.usage);
    return { content: textFrom(response.content), demo_mode: false };
  } catch (e) {
    logger.error("Claude vision call failed", errMeta(e));
    return { content: `{"sections":[],"notes":"Claude error: ${e}","confidence":"low"}`, demo_mode: false };
  }
}

/** Token accounting: log usage on every successful call so spend per
 *  model/call-site is visible in structured logs — no other metering exists. */
function logUsage(
  call: string,
  model: string,
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null },
) {
  if (!usage) return;
  logger.info("Claude usage", {
    call,
    model,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
  });
}

/** Multiple base64 images + text prompt (used for feature-detection voting). */
export async function callClaudeVisionMulti(
  systemPrompt: string,
  userText: string,
  images: VisionImage[],
  opts: { maxTokens?: number; model?: string } = {},
): Promise<VisionResult> {
  const { maxTokens = 1024, model = MODEL } = opts;
  const apiKey = getApiKey();
  const demo =
    '{"solar_panels":false,"solar_panels_confidence":"low",' +
    '"solar_hw":false,"solar_hw_confidence":"low",' +
    '"roof_style":"unknown","roof_style_confidence":"low",' +
    '"roof_material":"unknown","roof_material_confidence":"low",' +
    '"storeys":null,"condition":"unknown","other_features":[],"notes":';
  if (!apiKey) return { content: demo + '"Demo mode — no API key"}', demo_mode: true };
  try {
    const client = getClient(apiKey);
    const content: Anthropic.ContentBlockParam[] = images.map((img) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: (img.media_type ?? "image/jpeg") as "image/png" | "image/jpeg" | "image/gif" | "image/webp",
        data: img.b64,
      },
    }));
    content.push({ type: "text", text: userText });
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content }],
    });
    logUsage("vision-multi", model, response.usage);
    return { content: textFrom(response.content), demo_mode: false };
  } catch (e) {
    logger.error("Claude vision-multi call failed", errMeta(e));
    return { content: demo + `"Claude error: ${e}"}`, demo_mode: false };
  }
}

/** Text prompt with optional tool-use. Returns content + tool_uses. */
export async function callClaude(
  systemPrompt: string,
  userMessage: string,
  opts: { tools?: readonly ToolContract[]; maxTokens?: number; model?: string } = {},
): Promise<ChatResult> {
  return callClaudeConversation(systemPrompt, [{ role: "user", content: userMessage }], opts);
}

/** Multi-turn variant used by the platform assistant: pass prior turns
 *  (including tool_result blocks) verbatim. Same demo-mode contract. */
export async function callClaudeConversation(
  systemPrompt: string,
  messages: Anthropic.MessageParam[],
  opts: {
    /** Transport-neutral contracts (lib/platform/toolContract) — adapted to
     *  the SDK's Tool shape here, the only Anthropic conversion point. */
    tools?: readonly ToolContract[];
    maxTokens?: number;
    model?: string;
    /** When supplied, the reply is streamed: `reset` then a `delta` per text
     *  chunk. Tool-use turns still resolve normally via the return value. */
    onEvent?: (e: ChatStreamEvent) => void;
  } = {},
): Promise<ChatResult> {
  const { tools, maxTokens = 1024, model = MODEL, onEvent } = opts;
  const apiKey = getApiKey();
  if (!apiKey) {
    const last = messages[messages.length - 1];
    const lastText =
      typeof last?.content === "string"
        ? last.content
        : (last?.content ?? [])
            .map((b) => (typeof b === "object" && "text" in b ? (b as { text: string }).text : ""))
            .join(" ");
    const demo = demoResponse(lastText);
    if (onEvent) {
      onEvent({ type: "reset" });
      onEvent({ type: "delta", text: demo.content });
    }
    return demo;
  }
  try {
    const client = getClient(apiKey);
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: maxTokens,
      // Cache the system prompt: it's large (persona + rules + data snapshot)
      // and re-sent on every call of an agent's multi-round tool loop. The API
      // ignores the breakpoint for short prompts, so this is a no-op elsewhere.
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages,
    };
    if (tools?.length)
      params.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool["input_schema"],
      }));
    if (onEvent) {
      onEvent({ type: "reset" });
      const stream = client.messages.stream(params);
      stream.on("text", (delta) => onEvent({ type: "delta", text: delta }));
      const final = await stream.finalMessage();
      logUsage("conversation-stream", model, final.usage);
      return { ...parseBlocks(final.content), demo_mode: false };
    }
    const response = await client.messages.create(params);
    logUsage("conversation", model, response.usage);
    return { ...parseBlocks(response.content), demo_mode: false };
  } catch (e) {
    logger.error("Claude conversation call failed", errMeta(e));
    return { content: `[Claude API error: ${e}]`, tool_uses: [], demo_mode: false };
  }
}

/** Demo-mode canned responses — keyword-matched, mirrors _demo_response. */
function demoResponse(userMessage: string): ChatResult {
  const msg = userMessage.toLowerCase();
  // Note: time-of-day omitted (Date.now is unavailable in some sandboxes; the
  // marker text is preserved without the timestamp).
  const tag = "**[Demo Mode]**";
  let reply: string;

  const has = (...words: string[]) => words.some((w) => msg.includes(w));

  if (has("budget", "cost", "spend")) {
    reply =
      `${tag} Based on the project data, the current budget utilisation sits at **68%** across all phases. ` +
      "Phase 3 (Framing & Structure) shows a 12% variance — $8,400 over estimate, primarily driven by timber " +
      "price increases. Phase 1 (Site Works) closed within 2% of estimate. No immediate action required, but " +
      "recommend reviewing Phase 4 procurement before placing orders.";
  } else if (has("action", "task", "overdue", "due")) {
    reply =
      `${tag} I found **3 overdue action items** for your review:\n\n` +
      "1. **Electrical rough-in inspection** — due 3 days ago (Owner: Jack Henderson)\n" +
      "2. **Render quote finalisation** — due yesterday (Owner: Claudia Salem)\n" +
      "3. **Soil test report sign-off** — due 5 days ago (Owner: Site Supervisor)\n\n" +
      "Would you like me to update the due dates or send reminder notifications?";
  } else if (has("risk", "hazard", "danger")) {
    reply =
      `${tag} The current risk register has **2 HIGH** and **4 MEDIUM** risks active. The highest-priority item is: ` +
      "*Wet weather delays to slab pour* (Likelihood: High, Impact: High). Mitigation: monitor BOM 7-day forecast; " +
      "have pump-out contractor on standby. No new risks identified since last session.";
  } else if (has("vendor", "supplier", "contractor")) {
    reply =
      `${tag} Lighthouse Noosa (concrete supplier) has 3 invoices pending reconciliation. Per LRN-0030, I will ` +
      "cross-check CASHFLOWS before proposing any write to their records. Current total outstanding: $42,800. " +
      "Recommend confirming the 15-May delivery before processing payment.";
  } else if (has("hello", "hi", "start", "session")) {
    reply =
      `${tag} Good morning! Starting a new session. I've loaded your active learning rules and reviewed the ` +
      "activity log. No writes since last session (48 hours ago). ACTION_HUB shows 3 items overdue. How can I help you today?";
  } else {
    reply =
      `${tag} I've queried your workspace. Your question: *"${userMessage.slice(0, 80)}"* — ` +
      "Here's what the data shows: the project is currently 54% complete overall, on track for the August 2026 " +
      "target completion. Would you like me to drill into a specific phase, table, or topic?";
  }

  return {
    content: reply,
    tool_uses: [{ name: "get_records", input: { table: "ISSUES", filter: "" } }],
    demo_mode: true,
  };
}
