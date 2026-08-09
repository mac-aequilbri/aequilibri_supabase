// Health endpoint for load balancers and uptime monitoring.
//
//   GET /api/health — config checks plus cheap DB probes (SELECT 1 against
//                     the control and default tenant databases, AWS plan B4)
//                     so the ALB target-group check actually goes red when a
//                     database is unreachable, not just on config mistakes.
//
// Returns 200 with a per-check breakdown when healthy, 503 when any required
// check fails. No secrets appear in the response. Probes are time-boxed so a
// hung database turns the check red instead of hanging the health ping.

import { NextResponse } from "next/server";
import { controlDb, prisma } from "@/lib/db";
import { clerkEnabled, clerkMisconfigured, demoModeAllowed } from "@/lib/platform/authConfig";

export const dynamic = "force-dynamic";

type CheckState = "ok" | "fail";

const PROBE_TIMEOUT_MS = 3000;

async function probe(run: () => Promise<unknown>): Promise<CheckState> {
  try {
    await Promise.race([
      run(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("probe timeout")), PROBE_TIMEOUT_MS),
      ),
    ]);
    return "ok";
  } catch {
    return "fail";
  }
}

export async function GET(): Promise<NextResponse> {
  const [dbControl, dbTenant] = await Promise.all([
    probe(() => controlDb.$queryRaw`SELECT 1`),
    probe(() => prisma.$queryRaw`SELECT 1`),
  ]);

  const checks: Record<string, CheckState> = {
    // Auth: either Clerk fully configured or demo mode explicitly allowed;
    // a half-configured Clerk is a deployment mistake.
    auth_config: clerkMisconfigured() ? "fail" : clerkEnabled() || demoModeAllowed() ? "ok" : "fail",
    db_control: dbControl,
    db_tenant_default: dbTenant,
  };

  const ok = Object.values(checks).every((s) => s !== "fail");
  return NextResponse.json(
    { ok, checks, ts: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
