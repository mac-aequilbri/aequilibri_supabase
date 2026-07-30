// Health endpoint for load balancers and uptime monitoring.
//
//   GET /api/health — config-level checks only (cheap, no I/O), for
//                     high-frequency platform health pings.
//
// Returns 200 with a per-check breakdown when healthy, 503 when any required
// check fails — unlike the static landing page, this actually goes red on a
// deployment misconfiguration. No secrets appear in the response.

import { NextResponse } from "next/server";
import { clerkEnabled, clerkMisconfigured, demoModeAllowed } from "@/lib/platform/authConfig";

export const dynamic = "force-dynamic";

type CheckState = "ok" | "fail";

export async function GET(): Promise<NextResponse> {
  const checks: Record<string, CheckState> = {
    // Auth: either Clerk fully configured or demo mode explicitly allowed;
    // a half-configured Clerk is a deployment mistake.
    auth_config: clerkMisconfigured() ? "fail" : clerkEnabled() || demoModeAllowed() ? "ok" : "fail",
  };

  const ok = Object.values(checks).every((s) => s !== "fail");
  return NextResponse.json(
    { ok, checks, ts: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
