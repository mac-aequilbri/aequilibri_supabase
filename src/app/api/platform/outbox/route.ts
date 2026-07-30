// Outbound-event feed for the delivery worker (migration-plan Phase 6.3).
//
// The Airtable era had n8n poll the control base's PLAT_OUTBOX table directly;
// the queue now lives in the control DATABASE, so this route is the worker's
// only window onto it:
//
//   GET  /api/platform/outbox           → up to 50 pending events, oldest first
//   POST /api/platform/outbox           → { id, status: "delivered"|"failed", error? }
//
// Auth: `Authorization: Bearer <OUTBOX_FEED_SECRET>` (falls back to
// PLATFORM_WEBHOOK_SECRET so small deployments need one secret). Fail-closed:
// no secret configured → 503, wrong secret → 401. Event entity/job ids are
// PG-native numeric ids as strings; payload is the JSON the emitter attached.

import { NextRequest, NextResponse } from "next/server";
import { listPendingOutbox, markOutboxDelivery } from "@/lib/platform/controlPlane";

export const dynamic = "force-dynamic";

function authorized(req: NextRequest): NextResponse | null {
  const secret = process.env.OUTBOX_FEED_SECRET || process.env.PLATFORM_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Outbox feed is not configured" }, { status: 503 });
  }
  const header = req.headers.get("authorization") ?? "";
  if (header !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const denied = authorized(req);
  if (denied) return denied;
  const events = await listPendingOutbox(50);
  return NextResponse.json({
    events: events.map((e) => ({
      id: e.recordId,
      orgSlug: e.orgSlug,
      event: e.event,
      entityType: e.entityType,
      entityId: e.entityId,
      jobId: e.jobId,
      summary: e.summary,
      payload: e.payload,
      attempts: e.attempts,
      createdAt: e.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const denied = authorized(req);
  if (denied) return denied;
  let body: { id?: unknown; status?: unknown; error?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const id = String(body.id ?? "");
  const status = body.status === "delivered" || body.status === "failed" ? body.status : null;
  if (!id || !status) {
    return NextResponse.json(
      { error: 'Body must be { id, status: "delivered"|"failed", error? }' },
      { status: 400 },
    );
  }
  const ok = await markOutboxDelivery(id, status, typeof body.error === "string" ? body.error : undefined);
  if (!ok) return NextResponse.json({ error: `No outbox row ${id}` }, { status: 404 });
  return NextResponse.json({ ok: true });
}
