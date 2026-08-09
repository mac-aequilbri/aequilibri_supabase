// OAuth 2.0 Protected Resource Metadata (RFC 9728) for the MCP endpoint
// (mcp-assistant-plan W4). MCP clients discover the authorization server
// here: a 401 from /api/mcp/[org] carries a WWW-Authenticate challenge
// pointing at this document, whose `authorization_servers` names the
// env-configured issuer (Clerk's OAuth provider at go-live). The catch-all
// segment echoes the resource path, so
//   /.well-known/oauth-protected-resource/api/mcp/<org>
// describes the resource <origin>/api/mcp/<org>.
//
// 404 while MCP_OAUTH_ISSUER is unset: API-key auth needs no discovery, and
// advertising a non-existent authorization server would only mislead clients.

import { NextRequest, NextResponse } from "next/server";
import { oauthIssuer } from "@/services/platform/mcp/oauth";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ resource?: string[] }> },
): Promise<NextResponse> {
  const issuer = oauthIssuer();
  if (!issuer) {
    return NextResponse.json({ error: "OAuth is not configured" }, { status: 404 });
  }
  const { resource } = await params;
  const origin = request.nextUrl.origin;
  const path = resource?.length ? `/${resource.join("/")}` : "";
  return NextResponse.json({
    resource: `${origin}${path}`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "email", "profile"],
  });
}
