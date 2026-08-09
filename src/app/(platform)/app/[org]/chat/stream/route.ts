// Streaming send path for the standalone chat (/chat). Mirrors the assistant's
// stream route — a route handler so the client can render tokens as they arrive
// — but is gated on the `chat` feature flag and never pins a job (standalone
// conversations aren't scoped to a project). Emits newline-delimited JSON:
//   {"t":"reset"} | {"t":"delta","v":"…"} | {"t":"done"} | {"t":"error"}
// Persistence still happens inside sendChatMessage; the client calls
// router.refresh() once the stream ends.

import { NextRequest } from "next/server";
import { getCurrentViewer, requireOrgCtx } from "@/lib/platform/org-context";
import { recordIdParam } from "@/lib/platform/recordWriter";
import {
  deriveChatTitle,
  listMessages,
  renameChatSession,
  sendChatMessage,
} from "@/services/platform/assistant/chat";

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
  if (!ctx.config.features.chat) return new Response("Chat is not enabled", { status: 404 });
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

  // Auto-title a brand-new conversation from its first message. Cosmetic, so a
  // failure here must never block the send.
  if (sessionId != null) {
    try {
      const prior = await listMessages(ctx, sessionId);
      if (prior.length === 0) await renameChatSession(ctx, sessionId, deriveChatTitle(text));
    } catch {
      /* titling is best-effort */
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A client disconnect makes enqueue throw. Persistence happens inside
      // sendChatMessage and Airtable has no transactions — so a disconnect must
      // NOT abort the turn halfway through its writes. After the first failed
      // enqueue, delivery becomes a no-op and the turn completes server-side.
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
