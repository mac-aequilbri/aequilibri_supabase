# MCP architecture plan — per-client AI assistant ("Didi" pattern)

**Status:** PLAN — written 2026-08-08, nothing implemented.
**Scope:** evolving the platform assistant toward the target architecture
(chatbot → orchestration layer → LLM API + MCP client → MCP server →
database/APIs) **without weakening the per-client tenancy model**, which is
this plan's first design constraint, not an afterthought.

Target diagram (owner's sketch):

```
AI Chatbot (per-client persona)
      │
      ▼
Application / Orchestration Layer
      │
      ├── LLM API
      │
      └── MCP Client
             │
             ▼
        MCP Server  ── per-tenant session context ──►  THAT client's database
                                                        (control plane resolves which)
```

## 0. What already exists (verified in code, 2026-08-08)

The architecture above is ~80% built; only the MCP protocol boundary is
missing. Do not rebuild the existing layers.

| Diagram box | Today's implementation |
|---|---|
| AI Chatbot | `/assistant` + `/chat` surfaces; per-org name/persona from registry settings (`ctx.config.assistant`, `src/lib/platform/org-context.ts`) |
| Orchestration layer | `src/services/platform/agents/orchestrator.ts` (supervisor, agents-as-tools `delegate`, depth-capped) + `loop.ts` (per-specialist tool loop) + 7 specialists in `agents/registry.ts` |
| LLM API | `src/lib/claude.ts` — Anthropic SDK, streaming, prompt caching, usage logging, demo mode |
| MCP client/server → DB | **Gap.** Tools are in-process: `assistant/tools.ts` (definitions + role policy) → `assistant/executor.ts` → `recordWriter` (aiAuthority approval gate) / `runQuery` (RLS-scoped reads) → `db(ctx)` |

MCP therefore adds **protocol standardization and external reusability**, not
new capability. The in-app chatbot works today without it.

## 1. Tenancy constraints the MCP layer MUST preserve (verified in code)

| Constraint | Where it lives | Consequence for MCP |
|---|---|---|
| Database-per-client (§2b, owner decision 2026-07-29): `db(ctx)` resolves the org's own DB from `ctx.config.tenantDatabaseUrl`; org-isolation guard throws on unscoped queries | `src/lib/db.ts` | The MCP server must resolve the tenant DB from the **authenticated session's org**, via the control plane — never from a static connection string, never from a tool argument |
| Per-org assistant identity (name, persona, domain vocabulary, learning rules) | `org-context.ts`, `domainLabels.ts`, `learning.ts` | Prompt assembly stays in the app's orchestration layer; the MCP server serves data/actions only |
| Per-org write authority: `aiAuthority` → execute vs propose-for-approval (`PlatPendingWrite`) | `executor.ts` `requiresApproval`, `recordWriter` | The approval gate must sit **inside** the MCP server's tool handlers (by delegating to the existing executor), so no MCP client can bypass it |
| Per-user role gates (owner/builder/architect/broker write allow-lists, financial-table read denies) + RLS job scoping | `tools.ts` `roleCanUseTool`/`roleCanQueryTable`, `rls.ts` `currentJobScope` | The MCP session must carry **user** identity + role, not just org — two-level auth (org + user) |
| Audit attribution: every AI write logged to `EXECUTION_LOG` with actor + `sourceMessageId` | `executor.ts`, `chat.ts` | MCP tool calls must supply an `Actor`; calls from external clients need their own source attribution convention |
| Single app instance; per-process caches (AWS plan §1) | `docs/aws-deployment-plan.md` | An MCP server as a second service re-raises the shared-state questions the single-instance pin avoided — prefer same-process/same-task hosting initially |
| AU data residency (ap-southeast-2) | `docs/aws-deployment-plan.md` §8 | The MCP server deploys inside the same VPC/region; no third-party MCP hosting |

**The one rule that summarises this plan:** an MCP tool call without an
authenticated (org, user) session context must be impossible to execute — and
`orgId` must never be acceptable as a tool *parameter*.

## 2. Opening decisions (owner)

- **D1 — When.** MCP pays for itself only when a **second consumer** of the
  tools exists (n8n agent nodes, Claude Desktop/Code for the owner, a future
  client portal agent, cross-platform automations). For the in-app chatbot
  alone it adds a network hop and an auth problem for zero functional gain.
  **Recommendation:** keep the in-app assistant on the in-process path; build
  the MCP server when the first external consumer is named.
  **RESOLVED 2026-08-09 (owner): build now.** An earlier same-day resolution
  deferred MCP (the committing client's touchpoint is in-app), but the owner
  then made MCP readiness a requirement for this client. W1→W3 move onto the
  client timeline; W4 (OAuth) only when a human external consumer is named;
  W5 (routing the in-app assistant through the MCP client) is how "the
  architecture is MCP-based" is made demonstrable without a second consumer.
  The tenancy rules in §1 and the test matrix in §5 are unchanged and remain
  gating.
- **D2 — Topology.** (a) One **multi-tenant MCP server** (single deployment;
  session auth selects the org; internally mirrors `db(ctx)`), or (b) **one
  MCP endpoint per client org** (e.g. `mcp.<app>/o/<slug>`; simpler to reason
  about, cleaner offboarding, more moving parts). **Recommendation:** (a)
  multi-tenant server with per-org endpoints as a routing veneer — it reuses
  the exact `OrgCtx` machinery the app already trusts, and database-per-client
  isolation still applies underneath.
- **D3 — Consumer auth.** Human consumers (Claude Desktop/Code): OAuth 2.1
  per MCP spec, mapping to a Clerk user → org membership + role. Machine
  consumers (n8n): per-org scoped API keys in the control plane
  (`PlatCtlConnection` pattern already exists for n8n webhooks). Both resolve
  to the same `(OrgCtx, Actor, role)` triple before any tool runs.

## 3. Design

### 3.1 Server shape

- New package/entrypoint (e.g. `src/mcp/server.ts`) using
  `@modelcontextprotocol/sdk`, **Streamable HTTP** transport, hosted in the
  same ECS task (second port) or as a route under the Next app — NOT a
  separate always-on service initially (single-instance constraint, cost).
- Tools are **generated from the existing registry**: each agent tool bundle
  (`agents/*`) + `TOOL_POLICY` maps 1:1 to MCP tool definitions (the Anthropic
  `input_schema` JSON Schema translates directly).
- Every tool handler is a thin shim:
  `handler(input, session) → executeToolUse(session.ctx, session.actor, {name, input}, TOOL_POLICY, session.role)`.
  **No new data paths.** The executor keeps enforcing role gates, RLS scoping,
  aiAuthority approval, and audit logging — the protocol boundary adds zero
  new authority.
- Tool listing is **session-scoped**: a broker's session doesn't even see
  write tools their role can't use (defense in depth on top of the executor's
  own re-check).

### 3.2 Session → tenant resolution

1. Authenticate the transport (OAuth token or org API key).
2. Resolve org slug → control plane registry → build `OrgCtx` with the same
   loader the app uses (`org-context.ts` extracted to accept an explicit
   principal instead of the Next request).
3. Resolve user → role + job assignments (RLS scope).
4. Pin `(ctx, actor, role)` on the MCP session; every tool call reuses it.
5. Per-org rate limits + token/usage metering keyed on the session org.

### 3.3 What does NOT move behind MCP

- Prompt assembly (persona, learning rules, vocab, data snapshot) — stays in
  `chat.ts`; it's per-client presentation, not a tool.
- The orchestrator/specialist routing — stays in the app.
- The approval UI (`PlatPendingWrite` confirmation cards) — stays in the app;
  external MCP clients see "proposal #N recorded, pending human approval" as
  the tool result, exactly like the chat does today.

## 4. Workstreams

- **W1 — Contract extraction (no behavior change, do anytime):** factor the
  tool schemas + `TOOL_POLICY` into a transport-neutral module consumed by
  both `loop.ts` and the future MCP server; extract `OrgCtx` construction from
  the Next request path so it can be built from an arbitrary principal.
  This is also just good hygiene for the codebase.
  **DONE 2026-08-09:** `lib/platform/toolContract.ts` (SDK-free `ToolContract`;
  the registry in `assistant/tools.ts` and `AgentDefinition.tools` now use it;
  `lib/claude.ts` adapts to the Anthropic shape as the single conversion
  point) + `lib/platform/principal.ts` (request-free `resolveOrgCtx` /
  `resolveMember` / `resolveDefaultMember`; `org-context.ts` keeps the
  Clerk+redirect wrappers). Typecheck clean, 293/293 tests green.
- **W2 — MCP server MVP (read-only):** Streamable HTTP server exposing
  `query_records` + service reads only, org API-key auth, one pilot org.
  Exit: an external MCP client lists tools and reads that org's jobs — and a
  key for org A provably cannot read org B (test both directions).
  **DONE 2026-08-09:** `POST /api/mcp/[org]` (stateless Streamable HTTP,
  dependency-free JSON-RPC dispatch in `services/platform/mcp/server.ts`);
  session auth in `services/platform/mcp/session.ts` (org from URL, SHA-256
  key hash in registry settings via `scripts/mcp-issue-key.mjs`, active
  `mcp:in` connection row as the per-org kill switch, key bound to a member
  whose role/RLS scope apply — executor gained an explicit-viewer param so
  MCP never falls back to the Clerk request viewer). `onboarding_status`
  deliberately excluded (Clerk-coupled admin check). 16 tenancy tests
  (`mcp/mcp.test.ts`) cover §5's read-only rows; verified live against the
  dev server on the dulong-downs-didi pilot org incl. cross-org 401s.
- **W3 — Writes + approval gate:** enable write tools through the executor;
  verify a high-risk write from an external client lands as a
  `PlatPendingWrite` proposal and appears in the app's approval queue with
  correct actor attribution in `EXECUTION_LOG`.
  **DONE 2026-08-09:** the MCP surface is now the full assistant tool set
  minus `onboarding_status` (explicit allow-list in `mcp/server.ts`); tool
  listing is session-scoped by role. Six new tests prove: auto_low_risk
  executes low-risk writes with `mcp:<email>` EXECUTION_LOG attribution;
  high-risk ALWAYS proposes (even auto_low_risk); approve_required proposes
  everything; broker write gate holds; cross-org update refused by the
  ownership guard. Live-verified on dulong-downs-didi: the proposal landed
  in the org's OWN tenant database (aequilibri_t_dulong_downs_didi) via
  db(ctx) — the §5 provisioned-tenant-routing proof observed in the wild.
- **W4 — OAuth for human consumers** (Claude Desktop/Code): Clerk-backed
  OAuth 2.1 flow, role-scoped tool listing.
- **W5 — (Optional, later) internal dogfood:** route the in-app assistant's
  tool execution through the MCP client in staging to confirm parity; adopt
  only if the added hop earns its keep (it may never need to).
- **W6 — Ops:** deploy inside the AWS plan's VPC (ap-southeast-2), per-org
  rate limits, usage logging per session org, kill-switch per org
  (registry flag), offboarding = revoke keys + org's MCP access with its DB.

## 5. Test matrix (the tenancy proofs, non-negotiable before any org is live)

1. Cross-tenant read attempt (org A key, org B data) → refused at session
   resolution, and — if forced past it in a test harness — thrown by the
   org-isolation guard (two independent walls, same as `db.ts` today).
2. Role escalation: broker session calling `update_budget_line` → executor
   refusal (and the tool ideally not listed).
3. Approval gate: `propose_rule` via MCP under `propose_only` authority →
   proposal row, no direct write.
4. Audit: every MCP write traceable in `EXECUTION_LOG` with actor + source.
5. RLS: scoped viewer's session sees only assigned jobs via `query_records`.
6. Provisioned-tenant routing: an org with its own database gets served from
   that database (assert on connection, not just results).

## 6. Explicit non-goals

- Replacing the in-app chat pipeline (it stays in-process until W5 proves
  otherwise).
- Exposing raw SQL/table access via MCP — tools remain the fixed, policy-
  mapped verbs in `TOOL_POLICY`.
- Third-party/multi-region MCP hosting (residency).
