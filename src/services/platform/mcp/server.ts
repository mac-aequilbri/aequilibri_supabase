// MCP server core (mcp-assistant-plan W2) — stateless Streamable-HTTP MCP:
// each POST carries one JSON-RPC message and its own auth; no server-side
// session state, so the single-instance constraint is untouched and every
// message re-verifies against the control plane.
//
// W2 exposes the READ-ONLY tool subset. Every handler is a thin shim into
// executeToolUse — the same executor the in-app assistant uses — so role
// gates, per-table read denies and RLS job scoping apply identically; the
// protocol boundary adds zero new authority (plan §3.1). Write tools arrive
// in W3 behind the same executor's aiAuthority approval gate.
//
// Implemented directly (no SDK): the stateless subset is a small JSON-RPC 2.0
// dispatch (initialize / initialized / ping / tools list+call), and keeping
// it dependency-free means the whole tenant-auth surface is in this repo.

import { touchConnectionHealth } from "@/lib/platform/controlPlane";
import type { Actor } from "@/lib/platform/types";
import { executeToolUse } from "@/services/platform/assistant/executor";
import { policyByName, toolsByName } from "@/services/platform/assistant/tools";
import type { McpSession } from "./session";

// W2 tool surface: read-risk tools only. onboarding_status is deliberately
// excluded — it is a platform-operator tool whose admin check is coupled to
// the Clerk request context, which an MCP request does not have.
export const MCP_TOOL_NAMES = ["query_records", "suggest_ingestion_routes"] as const;
const MCP_TOOLS = toolsByName(MCP_TOOL_NAMES);
const MCP_POLICY = policyByName(MCP_TOOL_NAMES);

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "aequilibri-mcp", version: "0.1.0" };

type JsonRpcId = string | number | null;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId;
  method?: unknown;
  params?: unknown;
}

export interface McpHttpResult {
  status: number;
  /** null → empty response body (notifications are acknowledged with 202). */
  body: unknown | null;
}

function rpcResult(id: JsonRpcId, result: unknown): McpHttpResult {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function rpcError(id: JsonRpcId, code: number, message: string, status = 200): McpHttpResult {
  return { status, body: { jsonrpc: "2.0", id, error: { code, message } } };
}

/** The session's tool listing — MCP wire shape (inputSchema, not
 *  input_schema). W2's tools are read-risk so every role sees them; the
 *  executor still re-checks role + per-table denies on each call. */
function listTools() {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.input_schema,
  }));
}

async function callTool(session: McpSession, id: JsonRpcId, params: unknown): Promise<McpHttpResult> {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = String(p.name ?? "");
  if (!MCP_POLICY[name]) {
    return rpcError(id, -32602, `Unknown tool "${name}"`);
  }
  const args =
    p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {};

  // Attribution: the actor is the machine consumer acting AS the key's bound
  // member; role + viewer keep gating and RLS on that member's identity.
  const actor: Actor = {
    type: "ai",
    name: `mcp:${session.user.email}`,
    role: session.user.role,
  };
  const outcome = await executeToolUse(
    session.ctx,
    actor,
    { name, input: args, id: typeof id === "string" ? id : undefined },
    MCP_POLICY,
    session.user.role,
    { email: session.user.email, role: session.user.role },
  );
  void touchConnectionHealth(
    session.ctx.orgSlug,
    "mcp",
    "in",
    `${name}: ${outcome.ok ? "ok" : "error"}`,
  ).catch(() => {});

  // Per MCP: tool-level failures are results with isError, not protocol errors.
  return rpcResult(id, {
    content: [{ type: "text", text: outcome.summary }],
    isError: !outcome.ok,
  });
}

/** Dispatch one JSON-RPC message under an authenticated session. */
export async function handleMcpMessage(
  session: McpSession,
  message: unknown,
): Promise<McpHttpResult> {
  // JSON-RPC batching was removed from the MCP spec (2025-06-18); one message
  // per POST keeps the stateless contract simple.
  if (Array.isArray(message)) {
    return rpcError(null, -32600, "Batch requests are not supported", 400);
  }
  if (!message || typeof message !== "object") {
    return rpcError(null, -32600, "Invalid request", 400);
  }
  const msg = message as JsonRpcMessage;
  const id: JsonRpcId = msg.id === undefined ? null : msg.id;
  const method = String(msg.method ?? "");
  if (msg.jsonrpc !== "2.0" || !method) {
    return rpcError(id, -32600, "Invalid request", 400);
  }

  // Notifications (no id) are acknowledged and produce no body.
  if (msg.id === undefined) {
    return { status: 202, body: null };
  }

  switch (method) {
    case "initialize": {
      const params = (msg.params ?? {}) as { protocolVersion?: unknown };
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          `Read-only access to the ${session.ctx.orgName} workspace, acting as ` +
          `${session.user.email} (role: ${session.user.role}). Data visibility follows ` +
          `that member's permissions; writes are not available on this endpoint.`,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: listTools() });
    case "tools/call":
      return callTool(session, id, msg.params);
    default:
      return rpcError(id, -32601, `Method "${method}" not found`);
  }
}
