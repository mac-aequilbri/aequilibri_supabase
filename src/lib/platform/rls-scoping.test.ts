// Proof that RLS scoping actually FILTERS records per assignment — end to end
// through the real chain (assignment store → resolveJobScope → scopeRows), with
// only the true boundaries mocked: the control-base assignment store, the
// signed-in viewer, and the raw data reads. React's cache() is made a
// pass-through so currentJobScope is directly callable in a plain test.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  coreList: vi.fn(),
  listOptional: vi.fn(),
  listControlAssignments: vi.fn(),
  getCurrentViewer: vi.fn(),
  requireOrgCtx: vi.fn(),
  loadActionStatusMap: vi.fn(),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock("react", async (io) => ({ ...(await io<any>()), cache: (fn: any) => fn }));
vi.mock("@/lib/airtable", () => ({
  airtableEnabled: () => true,
  core: { list: h.coreList, get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock("@/lib/platform/controlPlane", () => ({
  controlPlaneEnabled: () => true,
  listControlAssignments: h.listControlAssignments,
}));
vi.mock("./org-context", () => ({
  getCurrentViewer: h.getCurrentViewer,
  requireOrgCtx: h.requireOrgCtx,
}));
vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("./optionalList", () => ({ listOptional: h.listOptional }));
vi.mock("./configSource", () => ({ loadActionStatusMap: h.loadActionStatusMap }));

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

/** Route core.list by table name to the given fixtures. */
function stubTables(tables: Record<string, unknown[]>) {
  h.coreList.mockImplementation(async (_slug: string, table: string) => tables[table] ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PROJECT_RLS_ENFORCE;
  h.loadActionStatusMap.mockResolvedValue({});
  h.listOptional.mockResolvedValue([]);
  h.getCurrentViewer.mockResolvedValue(BROKER);
});

// ── resolveJobScope: an assignment maps to exactly that job set (+ General) ──
describe("resolveJobScope (assignment → scope)", () => {
  it("a member's assignments become their job set, with General added", async () => {
    h.listControlAssignments.mockResolvedValue([
      { email: "u@x.io", jobRecId: "jA" },
      { email: "u@x.io", jobRecId: "jB" },
      { email: "other@x.io", jobRecId: "jZ" }, // someone else's — must NOT leak in
    ]);
    const scope = await resolveJobScope(makeCtx({ config: { features: {}, generalJobId: "jG" } }), BROKER);
    expect(scope.mode).toBe("some");
    expect(scope.mode === "some" && [...scope.jobIds].sort()).toEqual(["jA", "jB", "jG"]);
  });

  it("no assignment + not enforcing → whole tenant (fail-open)", async () => {
    h.listControlAssignments.mockResolvedValue([]);
    expect((await resolveJobScope(makeCtx(), BROKER)).mode).toBe("all");
  });

  it("no assignment + enforcing → only the General bucket", async () => {
    h.listControlAssignments.mockResolvedValue([]);
    const ctx = makeCtx({ config: { features: { project_rls_enforce: true }, generalJobId: "jG" } });
    const scope = await resolveJobScope(ctx, BROKER);
    expect(scope.mode === "some" && [...scope.jobIds]).toEqual(["jG"]);
  });

  it("exempt role (owner) → whole tenant regardless of assignments", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "jA" }]);
    expect((await resolveJobScope(makeCtx(), { ...BROKER, role: "owner" })).mode).toBe("all");
  });
});

// ── A list loader actually filters its rows per assignment ──────────────────
describe("loadRisks (list loader) filters per assignment", () => {
  it("returns only rows on assigned jobs (+ org-global), never other jobs'", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "jA" }]);
    stubTables({
      JOBS: [{ id: "jA", Job_Name: "A" }, { id: "jB", Job_Name: "B" }],
      RISKS: [
        { id: "r1", Risk: "assigned-job risk", Job: ["jA"], Status: "open" },
        { id: "r2", Risk: "OTHER job risk", Job: ["jB"], Status: "open" },
        { id: "r3", Risk: "org-global risk", Status: "open" }, // no Job link
      ],
    });
    const rows = await loadRisks(makeCtx());
    expect(rows.map((r) => r.id).sort()).toEqual(["r1", "r3"]); // jA + org-global; NOT r2 (jB)
  });

  it("exempt viewer sees every job's rows", async () => {
    h.getCurrentViewer.mockResolvedValue({ ...BROKER, role: "owner" });
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "jA" }]);
    stubTables({
      JOBS: [{ id: "jA", Job_Name: "A" }, { id: "jB", Job_Name: "B" }],
      RISKS: [
        { id: "r1", Risk: "a", Job: ["jA"], Status: "open" },
        { id: "r2", Risk: "b", Job: ["jB"], Status: "open" },
      ],
    });
    expect((await loadRisks(makeCtx())).map((r) => r.id).sort()).toEqual(["r1", "r2"]);
  });
});

// ── The job picker offers only assigned jobs (+ General) ────────────────────
describe("loadJobOptions (picker) filters per assignment", () => {
  it("lists only the viewer's assigned jobs plus General", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "jA" }]);
    stubTables({
      JOBS: [
        { id: "jA", Job_Name: "Assigned" },
        { id: "jB", Job_Name: "Other" },
        { id: "jG", Job_Name: "General" },
      ],
    });
    const opts = await loadJobOptions(makeCtx({ config: { features: {}, generalJobId: "jG" } }));
    expect(opts.map((o) => o.id).sort()).toEqual(["jA", "jG"]); // NOT jB
  });
});

// ── The project-plan board shows only assigned jobs' workstreams ────────────
describe("loadProjectPlan (workstreams) filters per assignment", () => {
  it("drops other jobs' workstreams, actions and risk scores", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "jA" }]);
    stubTables({
      JOBS: [{ id: "jA", Job_Name: "Assigned" }, { id: "jB", Job_Name: "Other" }],
      PHASES: [],
      ISSUES: [{ id: "a1", Action_Name: "other job action", Job: ["jB"], Status: "open" }],
      RISKS: [],
    });
    const rows = await loadProjectPlan(makeCtx());
    expect(rows.map((w) => w.id)).toEqual(["jA"]); // jB's workstream never rendered
  });
});

// ── ⌘K search returns no hits from unassigned jobs ──────────────────────────
describe("search route filters hits per assignment", () => {
  it("omits out-of-scope records but keeps org-global vendors", async () => {
    h.listControlAssignments.mockResolvedValue([{ email: "u@x.io", jobRecId: "jA" }]);
    h.requireOrgCtx.mockResolvedValue(makeCtx());
    stubTables({
      JOBS: [{ id: "jA", Job_Name: "widget A" }, { id: "jB", Job_Name: "widget B" }],
      ISSUES: [
        { id: "a1", Action_Name: "widget action mine", Job: ["jA"], Status: "open" },
        { id: "a2", Action_Name: "widget action theirs", Job: ["jB"], Status: "open" },
      ],
      RISKS: [],
      DECISIONS: [],
      CHANGE_LOG: [],
      DOCUMENTS: [],
    });
    h.listOptional.mockImplementation(async (_slug: string, table: string) =>
      table === "VENDORS" ? [{ id: "v1", Vendor_Name: "widget vendor", Category: "supply" }] : [],
    );
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
    const scope: JobScope = { mode: "some", jobIds: new Set(["jA"]) };
    stubTables({
      JOBS: [{ id: "jA" }, { id: "jB" }],
      ISSUES: [],
      PENDING_WRITES: [],
    });
    h.listOptional.mockImplementation(async (_slug: string, table: string) =>
      table === "RISKS"
        ? [
            { id: "rk1", Status: "open", Job: ["jA"] },
            { id: "rk2", Status: "open", Job: ["jB"] },
          ]
        : [],
    );
    const highlights = await loadOrgHighlights(makeCtx({ config: { features: { risks: true } } }), scope);
    expect(highlights.projects).toBe(1); // jA only
    expect(highlights.openRisks).toBe(1); // rk1 only
  });
});
