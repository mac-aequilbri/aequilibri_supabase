// Control-plane repository layer (migration-plan Phase 3, §2b topology).
//
// One seam for everything the platform asks of its control plane — org
// registry, team, RLS assignments, connections, outbox, and the three
// catalogs. Call sites import from HERE, never from lib/airtable/control
// directly; each function resolves the backing store internally:
//
//   - Airtable control base (legacy, `controlEnabled()`): delegates to
//     lib/airtable/control — behaviour unchanged during the transition.
//   - Postgres (the migration end-state): org registry/settings live on
//     PlatOrganisation; everything else on the PlatCtl* models. Per §2b these
//     are CONTROL-DB tables (split physically from tenant data later in
//     Phase 3) — they are exempt from the org-isolation guard's regex and are
//     keyed by orgSlug, not orgId FKs.
//
// Function names and shapes mirror lib/airtable/control 1:1 so the Phase 6
// decommission is: delete the airtable branches, inline the PG bodies.
//
// Record ids: the Airtable store uses rec… strings; the PG store uses numeric
// ids serialised as strings. Consumers treat recordId as opaque. Outbound
// events (outbox) therefore carry PG-native numeric entity/job ids as strings
// once an org runs on Postgres — the n8n side is reworked to match in Phase 6.

import { prisma } from "@/lib/db";
import { airtableEnabled } from "@/lib/airtable/config";
import * as air from "@/lib/airtable/control";
import { controlEnabled } from "@/lib/airtable/control";

export type {
  ConnectionDirection,
  ConnectionEntry,
  ControlAssignment,
  ControlTeamMember,
  JobCatalogEntry,
  NewConnection,
  NewJobCatalogEntry,
  NewOrgRegistry,
  NewTemplateRegistry,
  OrgDeletionResult,
  OrgMetricsSnapshot,
  OrgRegistryEntry,
  OutboxEntry,
  OutboxInput,
  ReportTemplateEntry,
  TemplateRegistryEntry,
} from "@/lib/airtable/control";
// controlEnabled ("the AIRTABLE control base backs the plane") is re-exported
// for the few genuinely Airtable-specific gates (registry-row snapshot cache,
// schema drift, base provisioning). Everything else gates on
// controlPlaneEnabled below.
export { connectionKey, controlEnabled, readMetricsSnapshot } from "@/lib/airtable/control";

/** Is a control plane available at all? Airtable mode needs the control base
 *  configured; Postgres mode always has one (it's just the database). The
 *  legacy `controlEnabled()` remains for Airtable-only concerns (schema
 *  drift, base provisioning); every platform feature gates on THIS. */
export function controlPlaneEnabled(): boolean {
  return controlEnabled() || !airtableEnabled();
}

/** True when the PG store backs the control plane (vs the Airtable base). */
function pg(): boolean {
  return !controlEnabled();
}

/** Airtable-store cache invalidation; the PG store is uncached. */
export function invalidateControlCache(slug: string): void {
  air.invalidateControlCache(slug);
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
}): air.OrgRegistryEntry {
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

export async function listOrgRegistry(): Promise<air.OrgRegistryEntry[]> {
  if (!pg()) return air.listOrgRegistry();
  const orgs = await prisma.platOrganisation.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
  return orgs.map(toEntry);
}

export async function getOrgRegistry(slug: string): Promise<air.OrgRegistryEntry | null> {
  if (!pg()) return air.getOrgRegistry(slug);
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

export async function saveMetricsSnapshot(slug: string, metrics: air.OrgMetricsSnapshot): Promise<void> {
  if (!pg()) return air.saveMetricsSnapshot(slug, metrics);
  await mergeSettings(slug, (s) => {
    s.metrics = metrics;
  });
}

export async function setGeneralJobId(slug: string, jobRecId: string): Promise<void> {
  if (!pg()) return air.setGeneralJobId(slug, jobRecId);
  if (!jobRecId) return;
  await mergeSettings(slug, (s) => {
    s.generalJobId = jobRecId;
  });
}

export async function setProjectRlsEnforce(slug: string, enabled: boolean): Promise<void> {
  if (!pg()) return air.setProjectRlsEnforce(slug, enabled);
  await mergeSettings(slug, (s) => {
    const features =
      s.features && typeof s.features === "object" ? (s.features as Record<string, unknown>) : {};
    features.project_rls_enforce = enabled;
    s.features = features;
  });
}

export async function getOrgWebhookSecret(slug: string): Promise<string | null> {
  if (!pg()) return air.getOrgWebhookSecret(slug);
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
  if (!pg()) return air.setOrgWebhookSecret(slug, secret);
  await mergeSettings(slug, (s) => {
    s.webhookSecret = secret;
  });
}

export async function setOrgAiAuthority(slug: string, aiAuthority: string): Promise<boolean> {
  if (!pg()) return air.setOrgAiAuthority(slug, aiAuthority);
  const org = await prisma.platOrganisation.findFirst({ where: { slug } });
  if (!org) return false;
  await prisma.platOrganisation.update({ where: { id: org.id }, data: { aiAuthority } });
  return true;
}

export async function createOrgRegistry(entry: air.NewOrgRegistry): Promise<number> {
  if (!pg()) return air.createOrgRegistry(entry);
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
export async function deleteOrgFromRegistry(slug: string): Promise<air.OrgDeletionResult> {
  if (!pg()) return air.deleteOrgFromRegistry(slug);
  const org = await prisma.platOrganisation.findFirst({ where: { slug } });
  if (!org) return { slug, baseId: null, removedRegistry: 0, removedTeam: 0 };
  const removedTeam = (await prisma.platCtlTeamMember.deleteMany({ where: { orgSlug: slug } })).count;
  await prisma.platCtlAssignment.deleteMany({ where: { orgSlug: slug } });
  await prisma.platOrganisation.update({ where: { id: org.id }, data: { isActive: false } });
  return { slug, baseId: org.airtableBaseId, removedRegistry: 1, removedTeam };
}

// ── Team (PG store: PlatCtlTeamMember, keyed by orgSlug) ────────────────────

export async function listControlTeamAll(slug: string): Promise<air.ControlTeamMember[]> {
  if (!pg()) return air.listControlTeamAll(slug);
  const rows = await prisma.platCtlTeamMember.findMany({
    where: { orgSlug: slug },
    orderBy: { id: "asc" },
  });
  return rows.map((m) => ({ name: m.name, email: m.email, role: m.role || "owner", isActive: m.isActive }));
}

export async function listControlTeam(slug: string): Promise<air.ControlTeamMember[]> {
  return (await listControlTeamAll(slug)).filter((m) => m.isActive);
}

export async function createControlTeamMember(
  slug: string,
  member: { name: string; email: string; role: string },
): Promise<void> {
  if (!pg()) return air.createControlTeamMember(slug, member);
  await prisma.platCtlTeamMember.create({
    data: { orgSlug: slug, name: member.name, email: member.email, role: member.role },
  });
}

export async function updateControlTeamMember(
  slug: string,
  email: string,
  patch: { role?: string; isActive?: boolean; name?: string },
): Promise<boolean> {
  if (!pg()) return air.updateControlTeamMember(slug, email, patch);
  const rows = await prisma.platCtlTeamMember.findMany({ where: { orgSlug: slug } });
  const match = rows.filter((m) => m.email.toLowerCase() === email.toLowerCase());
  if (!match.length) return false;
  for (const m of match) {
    await prisma.platCtlTeamMember.update({ where: { id: m.id }, data: patch });
  }
  return true;
}

// ── RLS assignments (PG store: PlatCtlAssignment) ───────────────────────────

export async function listControlAssignments(slug: string): Promise<air.ControlAssignment[]> {
  if (!pg()) return air.listControlAssignments(slug);
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
  if (!pg()) return air.setControlAssignments(slug, email, jobRecIds);
  const lower = email.toLowerCase();
  const unique = [...new Set(jobRecIds.filter(Boolean))];
  await prisma.$transaction(async (tx) => {
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
  if (!pg()) return air.addControlAssignment(slug, email, jobRecId);
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

function toConnection(r: CtlConnectionRow): air.ConnectionEntry {
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

export async function listConnections(orgSlug: string): Promise<air.ConnectionEntry[]> {
  if (!pg()) return air.listConnections(orgSlug);
  if (!orgSlug) return [];
  const rows = await prisma.platCtlConnection.findMany({ where: { orgSlug } });
  return rows
    .map(toConnection)
    .sort((a, b) => a.channel.localeCompare(b.channel) || a.direction.localeCompare(b.direction));
}

export async function getActiveConnection(
  orgSlug: string,
  channel: string,
  direction: air.ConnectionDirection,
): Promise<air.ConnectionEntry | null> {
  if (!pg()) return air.getActiveConnection(orgSlug, channel, direction);
  const row = await prisma.platCtlConnection.findFirst({
    where: { orgSlug, channel, direction, isActive: true },
  });
  return row ? toConnection(row) : null;
}

export async function createConnection(entry: air.NewConnection): Promise<void> {
  if (!pg()) return air.createConnection(entry);
  await prisma.platCtlConnection.create({
    data: {
      orgSlug: entry.orgSlug,
      channel: entry.channel,
      direction: entry.direction,
      connectionKey: air.connectionKey(entry.orgSlug, entry.channel, entry.direction),
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
  if (!pg()) return air.updateConnection(recordId, patch);
  const id = Number(recordId);
  if (!Number.isInteger(id) || Object.keys(patch).length === 0) return;
  await prisma.platCtlConnection.update({ where: { id }, data: patch });
}

export async function deleteConnection(recordId: string): Promise<void> {
  if (!pg()) return air.deleteConnection(recordId);
  const id = Number(recordId);
  if (!Number.isInteger(id)) return;
  await prisma.platCtlConnection.delete({ where: { id } });
}

export async function touchConnectionHealth(
  orgSlug: string,
  channel: string,
  direction: air.ConnectionDirection,
  status: string,
): Promise<void> {
  if (!pg()) return air.touchConnectionHealth(orgSlug, channel, direction, status);
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
  if (!pg()) return air.hasActiveOutbound(orgSlug);
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

function toOutbox(r: CtlOutboxRow): air.OutboxEntry {
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

export async function enqueueOutbox(input: air.OutboxInput): Promise<void> {
  if (!pg()) return air.enqueueOutbox(input);
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

export async function listOutbox(orgSlug: string, limit = 25): Promise<air.OutboxEntry[]> {
  if (!pg()) return air.listOutbox(orgSlug, limit);
  if (!orgSlug) return [];
  const rows = await prisma.platCtlOutbox.findMany({
    where: { orgSlug },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toOutbox);
}

export async function listFailedOutbox(limit = 200): Promise<air.OutboxEntry[]> {
  if (!pg()) return air.listFailedOutbox(limit);
  const rows = await prisma.platCtlOutbox.findMany({
    where: { status: "failed" },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  return rows.map(toOutbox);
}

export async function setOutboxStatus(recordId: string, status: string): Promise<void> {
  if (!pg()) return air.setOutboxStatus(recordId, status);
  const id = Number(recordId);
  if (!Number.isInteger(id)) return;
  await prisma.platCtlOutbox.update({ where: { id }, data: { status } });
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

function toReportTemplate(r: CtlReportRow): air.ReportTemplateEntry {
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

export async function listReportTemplates(orgSlug: string): Promise<air.ReportTemplateEntry[]> {
  if (!pg()) return air.listReportTemplates(orgSlug);
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
): Promise<air.ReportTemplateEntry | null> {
  if (!pg()) return air.getReportTemplate(orgSlug, key);
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
  if (!pg()) return air.createReportTemplate(entry);
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

function toTemplate(r: CtlTemplateRow): air.TemplateRegistryEntry {
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
): Promise<air.TemplateRegistryEntry[]> {
  if (!pg()) return air.listTemplateRegistry(opts);
  const rows = await prisma.platCtlTemplateRegistry.findMany();
  return rows
    .map(toTemplate)
    .filter((e) => e.templateBaseId && (opts.includeInactive || e.isActive))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.industry.localeCompare(b.industry));
}

export async function getTemplateRegistryEntry(
  recordId: string,
): Promise<air.TemplateRegistryEntry | null> {
  if (!pg()) return air.getTemplateRegistryEntry(recordId);
  const id = Number(recordId);
  if (!Number.isInteger(id)) return null;
  const row = await prisma.platCtlTemplateRegistry.findFirst({ where: { id } });
  return row ? toTemplate(row) : null;
}

export async function createTemplateRegistry(entry: air.NewTemplateRegistry): Promise<void> {
  if (!pg()) return air.createTemplateRegistry(entry);
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
  if (!pg()) return air.updateTemplateRegistry(recordId, patch);
  const id = Number(recordId);
  if (!Number.isInteger(id) || Object.keys(patch).length === 0) return;
  await prisma.platCtlTemplateRegistry.update({ where: { id }, data: patch });
}

export async function deleteTemplateRegistry(recordId: string): Promise<void> {
  if (!pg()) return air.deleteTemplateRegistry(recordId);
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

function toCatalog(r: CtlJobCatalogRow): air.JobCatalogEntry {
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
): Promise<air.JobCatalogEntry[]> {
  if (!pg()) return air.listJobCatalog(verticalKey, opts);
  if (!verticalKey) return [];
  const rows = await prisma.platCtlJobCatalog.findMany({ where: { verticalKey } });
  return rows
    .map(toCatalog)
    .filter((e) => e.key && (opts.includeInactive || e.isActive))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label));
}

export async function hasJobCatalog(verticalKey: string): Promise<boolean> {
  if (!pg()) return air.hasJobCatalog(verticalKey);
  if (!verticalKey) return false;
  const row = await prisma.platCtlJobCatalog.findFirst({ where: { verticalKey } });
  return row !== null;
}

export async function createJobCatalog(entries: air.NewJobCatalogEntry[]): Promise<void> {
  if (!pg()) return air.createJobCatalog(entries);
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
