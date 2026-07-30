// Proof that RLS scoping actually FILTERS records per assignment — end to end
// through the real chain (assignment store → resolveJobScope → scopeRows), with
// only the true boundaries mocked: the control-plane assignment store, the
// signed-in viewer, and the tenant-database reads (db(ctx) delegates). React's
// cache() is made a pass-through so currentJobScope is directly callable.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fixtures: {} as Record<string, Record<string, unknown>[]>,
  listControlAssignments: vi.fn(),
  getCurrentViewer: vi.fn(),
  requireOrgCtx: vi.fn(),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock("react", async (io) => ({ ...(await io<any>()), cache: (fn: any) => fn }));
vi.mock("@/lib/platform/controlPlane", () => ({
  controlPlaneEnabled: () => true,
  listControlAssignments: h.listControlAssignments,
}));
vi.mock("./org-context", () => ({
  getCurrentViewer: h.getCurrentViewer,
  requireOrgCtx: h.requireOrgCtx,
}));
// Tenant-database boundary: db(ctx) resolves every model delegate against the
// per-test fixtures (keyed by delegate name, e.g. platConRisk).
vi.mock("@/lib/db", () => {
  // Minimal where-matcher: scalar equality, {in: [...]}, and {lt: Date}
  // (enough for the loaders under test — scope filters are pushed into the
  // query as jobId/id {in} clauses). orgId always matches (single-org tests).
  const matches = (row: Record<string, unknown>, where: Record<string, unknown> | undefined) => {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === "orgId") continue;
      if (v !== null && typeof v === "object") {
        const cond = v as { in?: unknown[]; lt?: unknown };
        if (cond.in && !cond.in.includes(row[k])) return false;
        if (cond.lt !== undefined && !((row[k] as number | Date) < (cond.lt as number | Date))) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  };
  const delegate = (model: string) => ({
    findMany: async (args?: { where?: Record<string, unknown> }) =>
      (h.fixtures[model] ?? []).filter((r) => matches(r, args?.where)),
    findFirst: async (args?: { where?: Record<string, unknown> }) =>
      (h.fixtures[model] ?? []).find((r) => matches(r, args?.where)) ?? null,
    count: async (args?: { where?: Record<string, unknown> }) =>
      (h.fixtures[model] ?? []).filter((r) => matches(r, args?.where)).length,
    groupBy: async () => [],
    aggregate: async () => ({ _sum: {}, _count: 0 }),
  });
  const client = new Proxy(
    {},
    { get: (_t, prop: string) => (prop.startsWith("plat") ? delegate(prop) : undefined) },
  );
  return { prisma: client, prismaUnscoped: client, controlDb: client, db: () => client };
});
/* eslint-enable @typescript-eslint/no-explicit-any */

import { NextRequest } from "next/server";
import { resolveJobScope, type JobScope } from "./rls";
import { loadRisks } from "./risksSource";
import { loadJobOptions } from "./jobOptionsSource";
import { loadOrgHighlights } from "./orgHighlightsSource";
import { loadProjectPlan } from "./projectPlanSource";
import { GET as searchGET } from "@/app/(platform)/app/[org]/search/route";
import type { OrgCtx } from "./types";

const makeCtx = (over: Record<string, unknown> = {}): OrgCtx =>
  ({
    orgId: 1,
    orgSlug: "acme",
    orgName: "Acme",
    vertical: "construction",
    defaultEngagementType: "long_project",
    allowedEngagementTypes: ["long_project"],
    aiAuthority: "approve_required",
    config: { assistant: { name: "A", persona: "p" }, features: {} },
    ...over,
  }) as unknown as OrgCtx;

const BROKER = { email: "u@x.io", role: "broker", name: "U" };

function stubModels(fixtures: Record<string, Record<string, unknown>[]>) {
  h.fixtures = fixtures;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.fixtures = {};
  delete process.env.PROJECT_RLS_ENFORCE;
  h.getCurrentViewer.mockResolvedValue(BROKER);
});

// ── resolveJobScope: an assignment maps to exactly that job set (+ General) ──
describe("resolveJobScope (assignment → scope)", () => {
  it("a member's assignments become their job set, with General added", async () => {
    h.listControlAssignments.mockResolvedValue([
      { email: "u@x.io", jobRecId: "1" },
      { email: "u@x.io", jobRecId: "2" },
      { email: "other@x.io", jobRecId: "9" }, // someone else's — must NOT leak in
    ]);
    const scope = await resolveJobScope(makeCtx({ config: { features: {}, generalJobId: "3" } }), BROKER);
    expect(scope.mode).toBe("some");
    expect(scope.mode === "some" && [...scope.jobIds].sort()).toEqual(["1", "2", "3"]);
  });

  it("no assignment + not enforcing → whole tenant (fail-open)", async () => {
    h.listControlAssignments.mockResolvedValue([]);
    expect((await resolveJobScope(makeCtx(), BROKER)).mode).toBe("all");
  });

  it("no assignment + enforcing → only the General bucket", async () => {
    h.listControlAssignments.mockResolvedValue([]);
    const ctx = makeCtx({ config: { features: { project_rls_enforce: true }, generalJobId: "3" } });
    const scope = await resolveJobScope(ctx, BROKER);
    expect(scope.mode === "some" && [...scope.jobIds]).toEqual(["3"]);
  });

  it("exempt role (owner) → whole tenant regardless of assignments", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "1" }]);
    expect((await resolveJobScope(makeCtx(), { ...BROKER, role: "owner" })).mode).toBe("all");
  });
});

// ── A list loader actually filters its rows per assignment ──────────────────
describe("loadRisks (list loader) filters per assignment", () => {
  const RISKS = [
    { id: 1, description: "assigned-job risk", jobId: 1, job: { code: "A" }, likelihood: 3, impact: 3, mitigation: "", status: "open", owner: "", escalatedAt: null, escalationNote: "" },
    { id: 2, description: "OTHER job risk", jobId: 2, job: { code: "B" }, likelihood: 3, impact: 3, mitigation: "", status: "open", owner: "", escalatedAt: null, escalationNote: "" },
    { id: 3, description: "org-global risk", jobId: null, job: null, likelihood: 3, impact: 3, mitigation: "", status: "open", owner: "", escalatedAt: null, escalationNote: "" },
  ];

  it("returns only rows on assigned jobs (+ org-global), never other jobs'", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "1" }]);
    stubModels({ platConRisk: RISKS });
    const rows = await loadRisks(makeCtx());
    expect(rows.map((r) => r.id).sort()).toEqual(["1", "3"]); // job 1 + org-global; NOT job 2's
  });

  it("exempt viewer sees every job's rows", async () => {
    h.getCurrentViewer.mockResolvedValue({ ...BROKER, role: "owner" });
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "1" }]);
    stubModels({ platConRisk: RISKS });
    expect((await loadRisks(makeCtx())).map((r) => r.id).sort()).toEqual(["1", "2", "3"]);
  });
});

// ── The job picker offers only assigned jobs (+ General) ────────────────────
describe("loadJobOptions (picker) filters per assignment", () => {
  it("lists only the viewer's assigned jobs plus General", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "1" }]);
    stubModels({
      platJob: [
        { id: 1, code: "A-1", name: "Assigned" },
        { id: 2, code: "B-1", name: "Other" },
        { id: 3, code: "G-1", name: "General" },
      ],
    });
    const opts = await loadJobOptions(makeCtx({ config: { features: {}, generalJobId: "3" } }));
    expect(opts.map((o) => o.id).sort()).toEqual(["1", "3"]); // NOT job 2
  });
});

// ── The project-plan board shows only assigned jobs' workstreams ────────────
describe("loadProjectPlan (workstreams) filters per assignment", () => {
  it("drops other jobs' workstreams", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "1" }]);
    stubModels({
      platWorkstream: [
        { id: 11, name: "mine", status: "active", milestone: "", lastUpdated: new Date(), jobId: 1, job: { id: 1, code: "A-1" }, actions: [] },
        { id: 12, name: "theirs", status: "active", milestone: "", lastUpdated: new Date(), jobId: 2, job: { id: 2, code: "B-1" }, actions: [] },
      ],
      platConRisk: [],
    });
    const rows = await loadProjectPlan(makeCtx());
    expect(rows.map((w) => w.jobId ?? w.id)).toHaveLength(1);
  });
});

// ── ⌘K search returns no hits from unassigned jobs ──────────────────────────
describe("search route filters hits per assignment", () => {
  it("omits out-of-scope records but keeps org-global vendors", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "1" }]);
    h.requireOrgCtx.mockResolvedValue(makeCtx());
    stubModels({
      platJob: [
        { id: 1, code: "A-1", name: "widget A" },
        { id: 2, code: "B-1", name: "widget B" },
      ],
      platActionHub: [
        { id: 21, title: "widget action mine", jobId: 1, status: "open" },
        { id: 22, title: "widget action theirs", jobId: 2, status: "open" },
      ],
      platConRisk: [],
      platDecision: [],
      platConVariationOrder: [],
      platDocument: [],
      platConVendor: [{ id: 31, name: "widget vendor", category: "supply", isActive: true }],
      platConQuote: [],
    });
    const res = await searchGET(
      new NextRequest("http://localhost/app/acme/search?q=widget"),
      { params: Promise.resolve({ org: "acme" }) },
    );
    const { results } = (await res.json()) as { results: { label: string }[] };
    const labels = results.map((r) => r.label).sort();
    expect(labels).toEqual(["widget A", "widget action mine", "widget vendor"]);
  });
});

// ── An aggregate's counts filter to the given scope ─────────────────────────
describe("loadOrgHighlights (aggregate) counts only in-scope records", () => {
  it("projects and open-risk counts drop other jobs' records", async () => {
    const scope: JobScope = { mode: "some", jobIds: new Set(["1"]) };
    stubModels({
      platJob: [
        { id: 1, code: "A-1", name: "A" },
        { id: 2, code: "B-1", name: "B" },
      ],
      platActionHub: [],
      platPendingWrite: [],
      platConRisk: [
        { id: 41, status: "open", jobId: 1 },
        { id: 42, status: "open", jobId: 2 },
      ],
      platConVariationOrder: [],
    });
    const highlights = await loadOrgHighlights(makeCtx({ config: { features: { risks: true } } }), scope);
    expect(highlights.projects).toBe(1); // job 1 only
    expect(highlights.openRisks).toBe(1); // risk 41 only
  });
});
