// In-process MCP client (mcp-assistant-plan W5) — the in-app assistant's tool
// execution routed through the MCP server core. The agent loop dispatches the
// SAME JSON-RPC tools/call messages an external client sends over HTTP, into
// the SAME handleMcpMessage dispatch — so the architecture is genuinely
// chatbot → orchestration → MCP client → MCP server → tenant database, with
// the transport in-process (no loopback hop; the single-instance constraint
// and request latency are untouched).
//
// Parity with the pre-W5 direct-executor path is preserved by three session
// fields (see McpSession): `tools` pins the agent's bundle, `actor` keeps
// chat write provenance, `platformAdmin` carries the operator flag resolved
// where a real request context exists. The outcome's structured fields
// (status/proposalId/recordId — the approval cards' inputs) ride back in the
// MCP result's structuredContent.

import type { ToolUse } from "@/lib/claude";
import type { ToolOutcome } from "@/services/platform/assistant/executor";
import { handleMcpMessage } from "./server";
import type { McpSession } from "./session";

let seq = 0;

/** Execute one tool_use through the MCP server core, returning the executor's
 *  ToolOutcome shape the agent loop and approval cards expect. */
export async function executeToolViaMcp(session: McpSession, tu: ToolUse): Promise<ToolOutcome> {
  const res = await handleMcpMessage(session, {
    jsonrpc: "2.0",
    id: `app-${++seq}`,
    method: "tools/call",
    params: { name: tu.name, arguments: (tu.input ?? {}) as Record<string, unknown> },
  });
  const body = res.body as {
    result?: {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      structuredContent?: Partial<ToolOutcome>;
    };
    error?: { code: number; message: string };
  } | null;

  if (!body || body.error) {
    return {
      toolName: tu.name,
      ok: false,
      summary: body?.error?.message ?? "MCP call produced no response.",
    };
  }
  const r = body.result;
  const s = r?.structuredContent;
  return {
    toolName: s?.toolName ?? tu.name,
    ok: s?.ok ?? !r?.isError,
    summary: r?.content?.find((c) => c.type === "text")?.text ?? "",
    status: s?.status,
    proposalId: s?.proposalId,
    recordId: s?.recordId,
  };
}
