// Control-plane repository layer (migration-plan Phase 3, §2b topology;
// Airtable store decommissioned in Phase 6 — Postgres is the only backend).
//
// One seam for everything the platform asks of its control plane — org
// registry, team, RLS assignments, connections, outbox, and the three
// catalogs. The org registry/settings live on PlatOrganisation; everything
// else on the PlatCtl* models. Per §2b these are CONTROL-DB tables — exempt
// from the org-isolation guard's regex and keyed by orgSlug, not orgId FKs.
//
// Record ids are numeric ids serialised as strings (the historical Airtable
// store used rec… strings; consumers treat recordId as opaque either way).

import { controlDb, prisma } from "@/lib/db";

export interface OrgRegistryEntry {
  recordId: string;
  orgId: number;
  slug: string;
  name: string;
  vertical: string;
  defaultEngagementType: string;
  /** JSON array string, e.g. '["long_project"]'. */
  allowedEngagementTypes: string;
  aiAuthority: string;
  /** JSON object string (assistant + features). */
  settings: string;
  airtableBaseId: string | null;
  isActive: boolean;
}

export interface NewOrgRegistry {
  slug: string;
  name: string;
  vertical: string;
  defaultEngagementType: string;
  allowedEngagementTypes: string;
  aiAuthority: string;
  settings: string;
  airtableBaseId: string | null;
}

export interface OrgDeletionResult {
  slug: string;
  /** The org's legacy Airtable base id, if it had one (informational). */
  baseId: string | null;
  removedRegistry: number;
  removedTeam: number;
}

export interface ControlTeamMember {
  name: string;
  email: string;
  role: string;
  isActive: boolean;
}

export interface ControlAssignment {
  /** Lower-cased for case-insensitive matching against the viewer's email. */
  email: string;
  /** Job id the member is assigned to (numeric-as-string; legacy rows may
   *  carry Airtable rec… ids). */
  jobRecId: string;
}

export type ConnectionDirection = "in" | "out";

export interface ConnectionEntry {
  recordId: string;
  orgSlug: string;
  channel: string;
  direction: ConnectionDirection;
  isActive: boolean;
  eventFilter: string;
  credentialRef: string;
  lastEventAt: string;
  lastStatus: string;
  notes: string;
}

export interface NewConnection {
  orgSlug: string;
  channel: string;
  direction: ConnectionDirection;
  eventFilter?: string;
  credentialRef?: string;
  notes?: string;
}

export interface OutboxEntry {
  recordId: string;
  event: string;
  orgSlug: string;
  entityType: string;
  entityId: string;
  jobId: string;
  summary: string;
  status: string;
  attempts: number;
  createdAt: string;
  deliveredAt: string;
}

export interface OutboxInput {
  orgSlug: string;
  event: string;
  entityType: string;
  entityId: string;
  jobId?: string;
  summary?: string;
  data?: Record<string, unknown>;
}

export interface ReportTemplateEntry {
  recordId: string;
  key: string;
  orgSlug: string;
  title: string;
  prompt: string;
  scopes: string[];
  isActive: boolean;
}

export interface TemplateRegistryEntry {
  recordId: string;
  industry: string;
  subIndustry: string;
  verticalKey: string;
  templateBaseId: string;
  sortOrder: number;
  isActive: boolean;
}

export interface NewTemplateRegistry {
  industry: string;
  subIndustry: string;
  verticalKey: string;
  templateBaseId: string;
  sortOrder?: number;
  notes?: string;
}

export interface JobCatalogEntry {
  recordId: string;
  verticalKey: string;
  key: string;
  label: string;
  group: string;
  engagementType: string;
  scopeHint: string;
  phases: string[];
  sortOrder: number;
  /** "curated" (seeded) or "ai" (drafted at onboarding). */
  source: string;
  isActive: boolean;
}

export interface NewJobCatalogEntry {
  verticalKey: string;
  key: string;
  label: string;
  group: string;
  engagementType: string;
  scopeHint: string;
  phases: string[];
  sortOrder?: number;
  source?: string;
}

/** Denormalised org counts cached in the registry row's settings JSON, so the
 *  org picker cards and sidebar nav badges render without fan-out reads. */
export interface OrgMetricsSnapshot {
  projects: number;
  openActions: number;
  overdueActions: number;
  pendingApprovals: number;
  openRisks: number;
  openVariations: number;
  at: string;
}

const N = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Pull the cached metrics snapshot out of a registry row's settings JSON, or
 *  null when absent/malformed. */
export function readMetricsSnapshot(settingsRaw: string): OrgMetricsSnapshot | null {
  try {
    const m = (JSON.parse(settingsRaw) as { metrics?: Partial<OrgMetricsSnapshot> })?.metrics;
    if (!m || typeof m.at !== "string") return null;
    return {
      projects: N(m.projects),
      openActions: N(m.openActions),
      overdueActions: N(m.overdueActions),
      pendingApprovals: N(m.pendingApprovals),
      openRisks: N(m.openRisks),
      openVariations: N(m.openVariations),
      at: m.at,
    };
  } catch {
    return null;
  }
}

/** Stable identity for a connection row: one per (org, channel, direction). */
export function connectionKey(orgSlug: string, channel: string, direction: string): string {
  return `${orgSlug}:${channel}:${direction}`;
}

/** The control plane is the database — always available. Kept (constant true)
 *  because callers still gate features on it; collapses with the next dead-
 *  code pass. */
export function controlPlaneEnabled(): boolean {
  return true;
}

/** Historical Airtable-store cache invalidation — the PG store is uncached. */
export function invalidateControlCache(_slug: string): void {
  /* no-op */
}

// ── Org registry (PG store: PlatOrganisation) ───────────────────────────────

function toEntry(o: {
  id: number;
  slug: string;
  name: string;
  vertical: string;
  defaultEngagementType: string;
  allowedEngagementTypes: string;
  aiAuthority: string;
  settings: string;
  airtableBaseId: string | null;
  isActive: boolean;
}): OrgRegistryEntry {
  return {
    recordId: String(o.id),
    orgId: o.id,
    slug: o.slug,
    name: o.name,
    vertical: o.vertical,
    defaultEngagementType: o.defaultEngagementType,
    allowedEngagementTypes: o.allowedEngagementTypes,
    aiAuthority: o.aiAuthority,
    settings: o.settings,
    airtableBaseId: o.airtableBaseId,
    isActive: o.isActive,
  };
}

export async function listOrgRegistry(): Promise<OrgRegistryEntry[]> {
  const orgs = await prisma.platOrganisation.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
  return orgs.map(toEntry);
}

export async function getOrgRegistry(slug: string): Promise<OrgRegistryEntry | null> {
  const org = await prisma.platOrganisation.findFirst({ where: { slug } });
  return org ? toEntry(org) : null;
}

/** Merge a patch into an org's Settings JSON, preserving unrelated keys. */
async function mergeSettings(
  slug: string,
  patch: (settings: Record<string, unknown>) => void,
): Promise<void> {
  const org = await prisma.platOrganisation.findFirst({ where: { slug } });
  if (!org) return;
  let settings: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(org.settings || "{}");
    if (parsed && typeof parsed === "object") settings = parsed as Record<string, unknown>;
  } catch {
    /* start from empty on malformed settings rather than clobbering */
  }
  patch(settings);
  await prisma.platOrganisation.update({
    where: { id: org.id },
    data: { settings: JSON.stringify(settings) },
  });
}

export async function saveMetricsSnapshot(slug: string, metrics: OrgMetricsSnapshot): Promise<void> {
  await mergeSettings(slug, (s) => {
    s.metrics = metrics;
  });
}

export async function setGeneralJobId(slug: string, jobRecId: string): Promise<void> {
  if (!jobRecId) return;
  await mergeSettings(slug, (s) => {
    s.generalJobId = jobRecId;
  });
}

export async function setProjectRlsEnforce(slug: string, enabled: boolean): Promise<void> {
  await mergeSettings(slug, (s) => {
    const features =
      s.features && typeof s.features === "object" ? (s.features as Record<string, unknown>) : {};
    features.project_rls_enforce = enabled;
    s.features = features;
  });
}

export async function getOrgWebhookSecret(slug: string): Promise<string | null> {
  const entry = await getOrgRegistry(slug);
  if (!entry) return null;
  try {
    const parsed = JSON.parse(entry.settings || "{}") as { webhookSecret?: unknown };
    return typeof parsed.webhookSecret === "string" && parsed.webhookSecret ? parsed.webhookSecret : null;
  } catch {
    return null;
  }
}

export async function setOrgWebhookSecret(slug: string, secret: string): Promise<void> {
  await mergeSettings(slug, (s) => {
    s.webhookSecret = secret;
  });
}

// ── MCP API keys (mcp-assistant-plan W2) ─────────────────────────────────────
// Per-org keys for the /api/mcp/[org] endpoint, stored like webhookSecret in
// the registry settings JSON. Only the SHA-256 hash is stored — the plaintext
// key is shown once by scripts/mcp-issue-key.mjs. Each key is bound to an org
// member (memberEmail): the session acts AS that member, so role gates and
// RLS job scoping apply to every MCP call. Enablement (the per-org kill
// switch) is the active `mcp:in` connection row, mirroring the hooks route.

export interface McpKeyEntry {
  /** SHA-256 hex of the plaintext key. */
  keyHash: string;
  /** The org member this key acts as (role + RLS scope come from them). */
  memberEmail: string;
  label: string;
  createdAt: string;
}

export async function getOrgMcpKeys(slug: string): Promise<McpKeyEntry[]> {
  const entry = await getOrgRegistry(slug);
  if (!entry) return [];
  try {
    const parsed = JSON.parse(entry.settings || "{}") as { mcpKeys?: unknown };
    if (!Array.isArray(parsed.mcpKeys)) return [];
    return parsed.mcpKeys.filter(
      (k): k is McpKeyEntry =>
        !!k &&
        typeof k === "object" &&
        typeof (k as McpKeyEntry).keyHash === "string" &&
        typeof (k as McpKeyEntry).memberEmail === "string",
    );
  } catch {
    return [];
  }
}

export async function addOrgMcpKey(slug: string, key: McpKeyEntry): Promise<void> {
  await mergeSettings(slug, (s) => {
    const existing = Array.isArray(s.mcpKeys) ? s.mcpKeys : [];
    s.mcpKeys = [...existing, key];
  });
}

export async function setOrgAiAuthority(slug: string, aiAuthority: string): Promise<boolean> {
  const org = await prisma.platOrganisation.findFirst({ where: { slug } });
  if (!org) return false;
  await prisma.platOrganisation.update({ where: { id: org.id }, data: { aiAuthority } });
  return true;
}

export async function createOrgRegistry(entry: NewOrgRegistry): Promise<number> {
  const org = await prisma.platOrganisation.create({
    data: {
      slug: entry.slug,
      name: entry.name,
      vertical: entry.vertical,
      defaultEngagementType: entry.defaultEngagementType,
      allowedEngagementTypes: entry.allowedEngagementTypes,
      aiAuthority: entry.aiAuthority,
      settings: entry.settings,
      airtableBaseId: entry.airtableBaseId,
    },
  });
  return org.id;
}

/** PG offboarding deactivates the org (tenant data is preserved, mirroring the
 *  Airtable variant's undeletable customer base) and removes its control rows
 *  (team + assignments) so it disappears from the picker and auth. */
export async function deleteOrgFromRegistry(slug: string): Promise<OrgDeletionResult> {
  const org = await prisma.platOrganisation.findFirst({ where: { slug } });
  if (!org) return { slug, baseId: null, removedRegistry: 0, removedTeam: 0 };
  const removedTeam = (await prisma.platCtlTeamMember.deleteMany({ where: { orgSlug: slug } })).count;
  await prisma.platCtlAssignment.deleteMany({ where: { orgSlug: slug } });
  await prisma.platOrganisation.update({ where: { id: org.id }, data: { isActive: false } });
  return { slug, baseId: org.airtableBaseId, removedRegistry: 1, removedTeam };
}

// ── Team (PG store: PlatCtlTeamMember, keyed by orgSlug) ────────────────────

export async function listControlTeamAll(slug: string): Promise<ControlTeamMember[]> {
  const rows = await prisma.platCtlTeamMember.findMany({
    where: { orgSlug: slug },
    orderBy: { id: "asc" },
  });
  return rows.map((m) => ({ name: m.name, email: m.email, role: m.role || "owner", isActive: m.isActive }));
}

export async function listControlTeam(slug: string): Promise<ControlTeamMember[]> {
  return (await listControlTeamAll(slug)).filter((m) => m.isActive);
}

export async function createControlTeamMember(
  slug: string,
  member: { name: string; email: string; role: string },
): Promise<void> {
  await prisma.platCtlTeamMember.create({
    data: { orgSlug: slug, name: member.name, email: member.email, role: member.role },
  });
}

export async function updateControlTeamMember(
  slug: string,
  email: string,
  patch: { role?: string; isActive?: boolean; name?: string },
): Promise<boolean> {
  const rows = await prisma.platCtlTeamMember.findMany({ where: { orgSlug: slug } });
  const match = rows.filter((m) => m.email.toLowerCase() === email.toLowerCase());
  if (!match.length) return false;
  for (const m of match) {
    await prisma.platCtlTeamMember.update({ where: { id: m.id }, data: patch });
  }
  return true;
}

// ── RLS assignments (PG store: PlatCtlAssignment) ───────────────────────────

export async function listControlAssignments(slug: string): Promise<ControlAssignment[]> {
  const rows = await prisma.platCtlAssignment.findMany({ where: { orgSlug: slug } });
  return rows
    .map((a) => ({ email: a.email.toLowerCase(), jobRecId: a.jobRecId }))
    .filter((a) => a.email && a.jobRecId);
}

export async function setControlAssignments(
  slug: string,
  email: string,
  jobRecIds: string[],
): Promise<void> {
  const lower = email.toLowerCase();
  const unique = [...new Set(jobRecIds.filter(Boolean))];
  // Control-plane transaction — runs on the control DB explicitly (the
  // dispatch client's $transaction is tenant-side; see lib/db.ts).
  await controlDb.$transaction(async (tx) => {
    const existing = await tx.platCtlAssignment.findMany({ where: { orgSlug: slug } });
    const mine = existing.filter((a) => a.email.toLowerCase() === lower);
    if (mine.length) {
      await tx.platCtlAssignment.deleteMany({ where: { id: { in: mine.map((a) => a.id) } } });
    }
    if (unique.length) {
      await tx.platCtlAssignment.createMany({
        data: unique.map((jobRecId) => ({ orgSlug: slug, email: lower, jobRecId })),
      });
    }
  });
}

export async function addControlAssignment(
  slug: string,
  email: string,
  jobRecId: string,
): Promise<void> {
  if (!email || !jobRecId) return;
  const lower = email.toLowerCase();
  const rows = await prisma.platCtlAssignment.findMany({ where: { orgSlug: slug, jobRecId } });
  if (rows.some((a) => a.email.toLowerCase() === lower)) return;
  await prisma.platCtlAssignment.create({ data: { orgSlug: slug, email: lower, jobRecId } });
}

// ── Connections (PG store: PlatCtlConnection) ───────────────────────────────

type CtlConnectionRow = {
  id: number;
  orgSlug: string;
  channel: string;
  direction: string;
  isActive: boolean;
  eventFilter: string;
  credentialRef: string;
  lastEventAt: Date | null;
  lastStatus: string;
  notes: string;
};

function toConnection(r: CtlConnectionRow): ConnectionEntry {
  return {
    recordId: String(r.id),
    orgSlug: r.orgSlug,
    channel: r.channel,
    direction: r.direction === "out" ? "out" : "in",
    isActive: r.isActive,
    eventFilter: r.eventFilter,
    credentialRef: r.credentialRef,
    lastEventAt: r.lastEventAt ? r.lastEventAt.toISOString() : "",
    lastStatus: r.lastStatus,
    notes: r.notes,
  };
}

export async function listConnections(orgSlug: string): Promise<ConnectionEntry[]> {
  if (!orgSlug) return [];
  const rows = await prisma.platCtlConnection.findMany({ where: { orgSlug } });
  return rows
    .map(toConnection)
    .sort((a, b) => a.channel.localeCompare(b.channel) || a.direction.localeCompare(b.direction));
}

export async function getActiveConnection(
  orgSlug: string,
  channel: string,
  direction: ConnectionDirection,
): Promise<ConnectionEntry | null> {
  const row = await prisma.platCtlConnection.findFirst({
    where: { orgSlug, channel, direction, isActive: true },
  });
  return row ? toConnection(row) : null;
}

export async function createConnection(entry: NewConnection): Promise<void> {
  await prisma.platCtlConnection.create({
    data: {
      orgSlug: entry.orgSlug,
      channel: entry.channel,
      direction: entry.direction,
      connectionKey: connectionKey(entry.orgSlug, entry.channel, entry.direction),
      eventFilter: entry.eventFilter ?? "",
      credentialRef: entry.credentialRef ?? "",
      notes: entry.notes ?? "",
    },
  });
}

export async function updateConnection(
  recordId: string,
  patch: Partial<{ isActive: boolean; eventFilter: string; credentialRef: string; notes: string }>,
): Promise<void> {
  const id = Number(recordId);
  if (!Number.isInteger(id) || Object.keys(patch).length === 0) return;
  await prisma.platCtlConnection.update({ where: { id }, data: patch });
}

export async function deleteConnection(recordId: string): Promise<void> {
  const id = Number(recordId);
  if (!Number.isInteger(id)) return;
  await prisma.platCtlConnection.delete({ where: { id } });
}

export async function touchConnectionHealth(
  orgSlug: string,
  channel: string,
  direction: ConnectionDirection,
  status: string,
): Promise<void> {
  try {
    const row = await prisma.platCtlConnection.findFirst({ where: { orgSlug, channel, direction } });
    if (!row) return;
    await prisma.platCtlConnection.update({
      where: { id: row.id },
      data: { lastEventAt: new Date(), lastStatus: status.slice(0, 100) },
    });
  } catch {
    /* health telemetry is best-effort */
  }
}

export async function hasActiveOutbound(orgSlug: string): Promise<boolean> {
  if (!orgSlug) return false;
  const row = await prisma.platCtlConnection.findFirst({
    where: { orgSlug, direction: "out", isActive: true },
  });
  return row !== null;
}

// ── Outbox (PG store: PlatCtlOutbox) ────────────────────────────────────────

type CtlOutboxRow = {
  id: number;
  orgSlug: string;
  event: string;
  entityType: string;
  entityId: string;
  jobId: string;
  summary: string;
  status: string;
  attempts: number;
  deliveredAt: Date | null;
  createdAt: Date;
};

function toOutbox(r: CtlOutboxRow): OutboxEntry {
  return {
    recordId: String(r.id),
    event: r.event,
    orgSlug: r.orgSlug,
    entityType: r.entityType,
    entityId: r.entityId,
    jobId: r.jobId,
    summary: r.summary,
    status: r.status || "pending",
    attempts: r.attempts,
    createdAt: r.createdAt.toISOString(),
    deliveredAt: r.deliveredAt ? r.deliveredAt.toISOString() : "",
  };
}

export async function enqueueOutbox(input: OutboxInput): Promise<void> {
  await prisma.platCtlOutbox.create({
    data: {
      orgSlug: input.orgSlug,
      event: input.event,
      entityType: input.entityType,
      entityId: input.entityId,
      jobId: input.jobId ?? "",
      summary: input.summary ?? "",
      payload: input.data ? JSON.stringify(input.data) : "{}",
      status: "pending",
    },
  });
}

export async function listOutbox(orgSlug: string, limit = 25): Promise<OutboxEntry[]> {
  if (!orgSlug) return [];
  const rows = await prisma.platCtlOutbox.findMany({
    where: { orgSlug },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toOutbox);
}

export async function listFailedOutbox(limit = 200): Promise<OutboxEntry[]> {
  const rows = await prisma.platCtlOutbox.findMany({
    where: { status: "failed" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map(toOutbox);
}

export async function setOutboxStatus(recordId: string, status: string): Promise<void> {
  const id = Number(recordId);
  if (!Number.isInteger(id)) return;
  await prisma.platCtlOutbox.update({ where: { id }, data: { status } });
}

/** Pending outbound events for the delivery worker (n8n polls
 *  /api/platform/outbox). Oldest first, cross-org — the outbox is one
 *  control-plane queue; the worker routes on orgSlug. */
export async function listPendingOutbox(limit = 50): Promise<(OutboxEntry & { payload: string })[]> {
  const rows = await prisma.platCtlOutbox.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map((r) => ({ ...toOutbox(r), payload: r.payload }));
}

/** Delivery-worker acknowledgement: delivered stamps deliveredAt; failed bumps
 *  attempts and records the error (the scheduler's redrive sweep decides
 *  pending-vs-dead from the attempt count). */
export async function markOutboxDelivery(
  recordId: string,
  status: "delivered" | "failed",
  error?: string,
): Promise<boolean> {
  const id = Number(recordId);
  if (!Number.isInteger(id)) return false;
  const row = await prisma.platCtlOutbox.findFirst({ where: { id } });
  if (!row) return false;
  await prisma.platCtlOutbox.update({
    where: { id },
    data:
      status === "delivered"
        ? { status: "delivered", deliveredAt: new Date() }
        : { status: "failed", attempts: { increment: 1 }, lastError: (error ?? "").slice(0, 900) },
  });
  return true;
}

// ── Report catalog (PG store: PlatCtlReportCatalog) ─────────────────────────

type CtlReportRow = {
  id: number;
  orgSlug: string;
  key: string;
  title: string;
  prompt: string;
  scopes: string;
  isActive: boolean;
};

function toReportTemplate(r: CtlReportRow): ReportTemplateEntry {
  let scopes: string[] = [];
  try {
    const p = JSON.parse(r.scopes || "[]");
    if (Array.isArray(p)) scopes = p.map(String);
  } catch {
    /* leave empty on malformed JSON */
  }
  return {
    recordId: String(r.id),
    key: r.key,
    orgSlug: r.orgSlug,
    title: r.title,
    prompt: r.prompt,
    scopes,
    isActive: r.isActive,
  };
}

export async function listReportTemplates(orgSlug: string): Promise<ReportTemplateEntry[]> {
  if (!orgSlug) return [];
  const rows = await prisma.platCtlReportCatalog.findMany({ where: { orgSlug, isActive: true } });
  return rows
    .map(toReportTemplate)
    .filter((e) => e.key)
    .sort((a, b) => a.title.localeCompare(b.title));
}

export async function getReportTemplate(
  orgSlug: string,
  key: string,
): Promise<ReportTemplateEntry | null> {
  if (!key) return null;
  const row = await prisma.platCtlReportCatalog.findFirst({ where: { orgSlug, key, isActive: true } });
  return row ? toReportTemplate(row) : null;
}

export async function createReportTemplate(entry: {
  orgSlug: string;
  key: string;
  title: string;
  prompt: string;
  scopes: string[];
}): Promise<void> {
  await prisma.platCtlReportCatalog.create({
    data: {
      orgSlug: entry.orgSlug,
      key: entry.key,
      title: entry.title,
      prompt: entry.prompt,
      scopes: JSON.stringify(entry.scopes),
      source: "saved",
    },
  });
}

// ── Template registry (PG store: PlatCtlTemplateRegistry) ───────────────────
// In Postgres mode there are no Airtable template bases to clone, so this
// registry is expected to stay empty — the admin pages degrade to their
// empty states. Kept functional so Airtable-mode data can be mirrored in and
// so the industry→vertical mapping survives the migration (Phase 6 reworks
// onboarding to PG-native provisioning).

type CtlTemplateRow = {
  id: number;
  industry: string;
  subIndustry: string;
  verticalKey: string;
  templateBaseId: string;
  sortOrder: number;
  isActive: boolean;
};

function toTemplate(r: CtlTemplateRow): TemplateRegistryEntry {
  return {
    recordId: String(r.id),
    industry: r.industry,
    subIndustry: r.subIndustry,
    verticalKey: r.verticalKey,
    templateBaseId: r.templateBaseId,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
  };
}

export async function listTemplateRegistry(
  opts: { includeInactive?: boolean } = {},
): Promise<TemplateRegistryEntry[]> {
  const rows = await prisma.platCtlTemplateRegistry.findMany();
  return rows
    .map(toTemplate)
    .filter((e) => e.templateBaseId && (opts.includeInactive || e.isActive))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.industry.localeCompare(b.industry));
}

export async function getTemplateRegistryEntry(
  recordId: string,
): Promise<TemplateRegistryEntry | null> {
  const id = Number(recordId);
  if (!Number.isInteger(id)) return null;
  const row = await prisma.platCtlTemplateRegistry.findFirst({ where: { id } });
  return row ? toTemplate(row) : null;
}

export async function createTemplateRegistry(entry: NewTemplateRegistry): Promise<void> {
  await prisma.platCtlTemplateRegistry.create({
    data: {
      industry: entry.industry,
      subIndustry: entry.subIndustry,
      verticalKey: entry.verticalKey,
      templateBaseId: entry.templateBaseId,
      sortOrder: entry.sortOrder ?? 0,
      notes: entry.notes ?? "",
    },
  });
}

export async function updateTemplateRegistry(
  recordId: string,
  patch: Partial<{
    templateBaseId: string;
    verticalKey: string;
    sortOrder: number;
    isActive: boolean;
    notes: string;
  }>,
): Promise<void> {
  const id = Number(recordId);
  if (!Number.isInteger(id) || Object.keys(patch).length === 0) return;
  await prisma.platCtlTemplateRegistry.update({ where: { id }, data: patch });
}

export async function deleteTemplateRegistry(recordId: string): Promise<void> {
  const id = Number(recordId);
  if (!Number.isInteger(id)) return;
  await prisma.platCtlTemplateRegistry.delete({ where: { id } });
}

// ── Job catalog (PG store: PlatCtlJobCatalog) ───────────────────────────────

type CtlJobCatalogRow = {
  id: number;
  verticalKey: string;
  key: string;
  label: string;
  categoryGroup: string;
  engagementType: string;
  scopeHint: string;
  phases: string;
  sortOrder: number;
  source: string;
  isActive: boolean;
};

function toCatalog(r: CtlJobCatalogRow): JobCatalogEntry {
  let phases: string[] = [];
  try {
    const p = JSON.parse(r.phases || "[]");
    if (Array.isArray(p)) phases = p.map(String);
  } catch {
    /* leave empty on malformed JSON */
  }
  return {
    recordId: String(r.id),
    verticalKey: r.verticalKey,
    key: r.key,
    label: r.label,
    group: r.categoryGroup,
    engagementType: r.engagementType || "short_job",
    scopeHint: r.scopeHint,
    phases,
    sortOrder: r.sortOrder,
    source: r.source || "curated",
    isActive: r.isActive,
  };
}

export async function listJobCatalog(
  verticalKey: string,
  opts: { includeInactive?: boolean } = {},
): Promise<JobCatalogEntry[]> {
  if (!verticalKey) return [];
  const rows = await prisma.platCtlJobCatalog.findMany({ where: { verticalKey } });
  return rows
    .map(toCatalog)
    .filter((e) => e.key && (opts.includeInactive || e.isActive))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export async function hasJobCatalog(verticalKey: string): Promise<boolean> {
  if (!verticalKey) return false;
  const row = await prisma.platCtlJobCatalog.findFirst({ where: { verticalKey } });
  return row !== null;
}

export async function createJobCatalog(entries: NewJobCatalogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  await prisma.platCtlJobCatalog.createMany({
    data: entries.map((e) => ({
      verticalKey: e.verticalKey,
      key: e.key,
      label: e.label,
      categoryGroup: e.group,
      engagementType: e.engagementType,
      scopeHint: e.scopeHint,
      phases: JSON.stringify(e.phases),
      sortOrder: e.sortOrder ?? 0,
      source: e.source ?? "ai",
    })),
  });
}
