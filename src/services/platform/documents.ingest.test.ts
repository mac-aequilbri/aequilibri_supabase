// Inbound ingestion: externalId dedup + the ingestUnreadEmails → ingestInboundMessage
// extraction. Runs fully mocked (demo/Postgres path, no DB, no network, no FS) —
// attachments are omitted so the storage/classify branch never fires.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgCtx } from "@/lib/platform/types";

const h = vi.hoisted(() => ({
  docFindFirst: vi.fn(),
  docFindMany: vi.fn(),
  jobFindMany: vi.fn(),
  writeRecord: vi.fn(),
  fetchUnread: vi.fn(),
  markProcessed: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const client = {
    platDocument: { findFirst: h.docFindFirst, findMany: h.docFindMany },
    platJob: { findMany: h.jobFindMany },
  };
  // db(ctx) resolves to the same stub — these tests run against a
  // non-activated org (shared tenant DB).
  return { prisma: client, db: () => client };
});

vi.mock("@/lib/platform/recordWriter", () => ({ writeRecord: h.writeRecord }));

vi.mock("@/lib/platform/email", () => ({
  getEmailReader: () => ({ fetchUnread: h.fetchUnread, markProcessed: h.markProcessed, close: vi.fn() }),
}));

import { ingestInboundMessage, ingestUnreadEmails } from "./documents";

const ctx = { orgId: 1, orgSlug: "test" } as unknown as OrgCtx;

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults for the "fresh message" path — individual tests override.
  h.docFindFirst.mockResolvedValue(null); // findByExternalId → not seen
  h.jobFindMany.mockResolvedValue([]); // resolveJobContext → no single job
  h.docFindMany.mockResolvedValue([]); // findPriorVersion → no prior
  h.writeRecord.mockResolvedValue({ recordId: 1 });
});

describe("ingestInboundMessage — dedup", () => {
  it("skips a message whose (channel, externalId) was already ingested", async () => {
    h.docFindFirst.mockResolvedValue({ id: 99 }); // already present
    const res = await ingestInboundMessage(ctx, "slack webhook", {
      channel: "slack",
      externalId: "m-1",
      body: "duplicate delivery",
    });
    expect(res).toEqual({ deduped: true, documents: 0, proposals: 0 });
    expect(h.writeRecord).not.toHaveBeenCalled();
  });

  it("ingests a fresh message as one document (no job → no proposals)", async () => {
    const res = await ingestInboundMessage(ctx, "slack webhook", {
      channel: "slack",
      externalId: "m-2",
      subject: "Quote question",
      body: "hello there",
    });
    expect(res).toEqual({ deduped: false, documents: 1, proposals: 0 });
    expect(h.writeRecord).toHaveBeenCalledTimes(1); // the create, no routing writes
  });
});

describe("ingestUnreadEmails — delegates to ingestInboundMessage", () => {
  it("processes each fetched email and marks it read (counts preserved)", async () => {
    h.fetchUnread.mockResolvedValue([
      { id: "e1", from: "a@x.com", subject: "One", body: "b1", receivedAt: "2026-06-10T00:00:00Z", attachments: [] },
      { id: "e2", from: "b@x.com", subject: "Two", body: "b2", receivedAt: "2026-06-11T00:00:00Z", attachments: [] },
    ]);
    const res = await ingestUnreadEmails(ctx, "Inbox");
    expect(res).toEqual({ processed: 2, documents: 2, proposals: 0 });
    expect(h.markProcessed).toHaveBeenCalledTimes(2);
  });
});
