// Per-org MCP endpoint (mcp-assistant-plan W2) — stateless Streamable HTTP:
//
//   POST /api/mcp/<org-slug>
//   Authorization: Bearer <key from scripts/mcp-issue-key.mjs>
//   { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
//
// The org comes from the URL and the key must verify against that org's
// registry (services/platform/mcp/session) — org identity is never read from
// the request body. GET/DELETE are 405: stateless mode has no server-opened
// stream and no session to delete.

import { NextRequest, NextResponse } from "next/server";
import { resolveMcpSession } from "@/services/platform/mcp/session";
import { handleMcpMessage } from "@/services/platform/mcp/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// MCP messages are small JSON-RPC envelopes; anything near this is abuse.
const MAX_BODY_BYTES = 1 * 1024 * 1024;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ org: string }> },
): Promise<NextResponse> {
  const { org } = await params;

  const auth = await resolveMcpSession(org, request.headers.get("authorization"));
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  const res = await handleMcpMessage(auth.session, message);
  if (res.body === null) return new NextResponse(null, { status: res.status });
  return NextResponse.json(res.body, { status: res.status });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "This MCP endpoint is stateless — POST JSON-RPC messages; no event stream." },
    { status: 405 },
  );
}

export async function DELETE(): Promise<NextResponse> {
  return NextResponse.json({ error: "Stateless endpoint — no session to delete." }, { status: 405 });
}
