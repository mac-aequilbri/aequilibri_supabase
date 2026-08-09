// Streaming send path for the assistant. A route handler (not a server action)
// so the client can fetch() it and render tokens as they arrive, instead of
// blocking on the whole orchestrator fan-out and then swapping the subtree for
// the [org] loading fallback on an RSC refresh. Emits newline-delimited JSON:
//   {"t":"reset"}            — a new model call began; drop prior deltas
//   {"t":"delta","v":"…"}   — a chunk of the reply text
//   {"t":"done"} | {"t":"error"}
// Persistence (message rows, execution log, pending writes) still happens inside
// sendChatMessage; the client calls router.refresh() once the stream ends.

import { NextRequest } from "next/server";
import { getCurrentViewer, requireOrgCtx } from "@/lib/platform/org-context";
import { recordIdParam } from "@/lib/platform/recordWriter";
import { sendChatMessage } from "@/services/platform/assistant/chat";

export const dynamic = "force-dynamic";
// Backstop for a hung upstream call — without it a stuck stream holds the
// connection open indefinitely.
export const maxDuration = 300;

function idFrom(v: unknown): ReturnType<typeof recordIdParam> {
  return recordIdParam(typeof v === "string" || typeof v === "number" ? String(v) : null);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const ctx = await requireOrgCtx(org);
  const user = await getCurrentViewer(ctx);

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    /* empty body → nothing to send */
  }
  const text = typeof body.message === "string" ? body.message.trim() : "";
  if (!text) return new Response("Missing message", { status: 400 });

  const sessionId = idFrom(body.sessionId) ?? undefined;
  const jobId = idFrom(body.jobId) ?? undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A client disconnect makes enqueue throw. Persistence (message rows,
      // proposals, execution log) happens inside sendChatMessage and Airtable
      // has no transactions — so a disconnect must NOT abort the turn halfway
      // through its writes. After the first failed enqueue, delivery becomes a
      // no-op and the turn completes server-side.
      let clientGone = false;
      const send = (obj: unknown) => {
        if (clientGone) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          clientGone = true;
        }
      };
      try {
        await sendChatMessage(ctx, user.name, text, {
          sessionId,
          jobId,
          userRole: user.role,
          userEmail: user.email,
          onEvent: (e) => send(e.type === "reset" ? { t: "reset" } : { t: "delta", v: e.text }),
        });
        send({ t: "done" });
      } catch {
        // Detail is logged inside the send path; the wire gets a generic
        // marker so internal error text never reaches the network tab.
        send({ t: "error", v: "send failed" });
      } finally {
        if (!clientGone) controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
