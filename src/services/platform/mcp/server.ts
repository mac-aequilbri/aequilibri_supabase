// MCP server core (mcp-assistant-plan W2) — stateless Streamable-HTTP MCP:
// each POST carries one JSON-RPC message and its own auth; no server-side
// session state, so the single-instance constraint is untouched and every
// message re-verifies against the control plane.
//
// Every handler is a thin shim into executeToolUse — the same executor the
// in-app assistant uses — so role gates, per-table read denies, RLS job
// scoping and the org's aiAuthority approval policy apply identically; the
// protocol boundary adds zero new authority (plan §3.1). A write an MCP
// client proposes lands as a PlatPendingWrite in the app's approval queue
// exactly like a chat-proposed one; nothing on this path can bypass it.
//
// Implemented directly (no SDK): the stateless subset is a small JSON-RPC 2.0
// dispatch (initialize / initialized / ping / tools list+call), and keeping
// it dependency-free means the whole tenant-auth surface is in this repo.

import { touchConnectionHealth } from "@/lib/platform/controlPlane";
import { logger } from "@/lib/logger";
import type { Actor } from "@/lib/platform/types";
import { executeToolUse } from "@/services/platform/assistant/executor";
import { policyByName, roleCanUseTool, toolsByName } from "@/services/platform/assistant/tools";
import type { McpSession } from "./session";

// The MCP tool surface (W2 reads + W3 writes): an explicit allow-list, not
// "everything in TOOL_POLICY", so a future tool never appears here silently.
// onboarding_status is a platform-operator tool: only sessions with
// platformAdmin (the in-app client under an operator, plan W5) list or pass
// it — API-key sessions are never platform admins.
export const MCP_TOOL_NAMES = [
  // reads
  "query_records",
  "describe_data",
  "get_record",
  "suggest_ingestion_routes",
  // generic proposals — any proposable table/field, same approval gate
  "propose_create",
  "propose_update",
  "propose_delete",
  // record writes — routed through recordWriter under aiAuthority
  "capture_source_note",
  "create_action",
  "update_action",
  "save_decision",
  "propose_rule",
  "update_budget_line",
  "create_variation_draft",
  "create_risk",
  "draft_comm",
  "log_workstream_update",
  // service drafts — human-reviewed downstream lifecycle
  "generate_weekly_report",
  "run_construction_intake",
  // platform-operator only (session.platformAdmin)
  "onboarding_status",
] as const;
const MCP_TOOLS = toolsByName(MCP_TOOL_NAMES);
const MCP_POLICY = policyByName(MCP_TOOL_NAMES);

/** Is a tool callable in THIS session — on the surface, inside the session's
 *  tool subset (agent bundle), and operator-gated where required. */
function sessionAllows(session: McpSession, name: string): boolean {
  if (!MCP_POLICY[name]) return false;
  if (session.tools && !session.tools.includes(name)) return false;
  if (name === "onboarding_status" && session.platformAdmin !== true) return false;
  return true;
}

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
 *  input_schema), filtered to the session's subset and the tools the member's
 *  role may use (plan §3.1: a broker doesn't even see write tools their role
 *  can't call). Defense in depth only — every call is re-checked. */
function listTools(session: McpSession) {
  return MCP_TOOLS.filter(
    (t) => sessionAllows(session, t.name) && roleCanUseTool(session.user.role, t.name, MCP_POLICY),
  ).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.input_schema,
  }));
}

async function callTool(session: McpSession, id: JsonRpcId, params: unknown): Promise<McpHttpResult> {
  const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
  const name = String(p.name ?? "");
  if (!sessionAllows(session, name)) {
    return rpcError(id, -32602, `Unknown tool "${name}"`);
  }
  const args =
    p.arguments && typeof p.arguments === "object" ? (p.arguments as Record<string, unknown>) : {};

  // Attribution: external sessions act as the machine consumer for the key's
  // bound member; the in-app client overrides with the chat actor so write
  // provenance (assistant name, sourceMessageId) survives the MCP routing.
  const actor: Actor = session.actor ?? {
    type: "ai",
    name: `mcp:${session.user.email}`,
    role: session.user.role,
  };
  const startedAt = Date.now();
  const outcome = await executeToolUse(
    session.ctx,
    actor,
    { name, input: args, id: typeof id === "string" ? id : undefined },
    MCP_POLICY,
    session.user.role,
    {
      email: session.user.email,
      role: session.user.role,
      platformAdmin: session.platformAdmin === true,
    },
  );
  // W6 usage metering — one structured line per tool call, keyed by org, so
  // per-tenant MCP volume/spend is queryable from logs (CloudWatch on AWS),
  // mirroring the "Claude usage" pattern in lib/claude.ts.
  logger.info("MCP usage", {
    orgSlug: session.ctx.orgSlug,
    tool: name,
    ok: outcome.ok,
    status: outcome.status,
    external: !session.actor,
    actingAs: session.user.email,
    ms: Date.now() - startedAt,
  });
  if (!session.actor) {
    // Health telemetry is for external consumers; the in-app path has its own
    // EXECUTION_LOG chat entries.
    void touchConnectionHealth(
      session.ctx.orgSlug,
      "mcp",
      "in",
      `${name}: ${outcome.ok ? "ok" : "error"}`,
    ).catch(() => {});
  }

  // Per MCP: tool-level failures are results with isError, not protocol
  // errors. structuredContent mirrors the executor's ToolOutcome so clients
  // (and the in-app MCP client, plan W5) keep proposalId/recordId/status.
  return rpcResult(id, {
    content: [{ type: "text", text: outcome.summary }],
    isError: !outcome.ok,
    structuredContent: {
      toolName: outcome.toolName,
      ok: outcome.ok,
      ...(outcome.status ? { status: outcome.status } : {}),
      ...(outcome.proposalId != null ? { proposalId: outcome.proposalId } : {}),
      ...(outcome.recordId != null ? { recordId: outcome.recordId } : {}),
    },
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
          `Access to the ${session.ctx.orgName} workspace, acting as ` +
          `${session.user.email} (role: ${session.user.role}). Data visibility and write ` +
          `access follow that member's permissions. Writes are governed by the ` +
          `organisation's AI-authority policy: they may be executed immediately or ` +
          `recorded as proposals that a human must approve in the app before they apply — ` +
          `the tool result says which happened.`,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: listTools(session) });
    case "tools/call":
      return callTool(session, id, msg.params);
    default:
      return rpcError(id, -32601, `Method "${method}" not found`);
  }
}
