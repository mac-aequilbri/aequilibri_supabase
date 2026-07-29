// Cross-org schema-drift report (Module 1 "operations infrastructure", spec
// Phase 5). Customer bases are clones of the template, not live-connected, so
// they drift as the template's schema evolves. This compares every org's base
// against the template's *provisionable* schema (see expectedPlatformSchema)
// and reports which tables/fields each base is missing.
//
// Read-only and best-effort: one base failing to read never breaks the report.

import { airtableEnabled } from "@/lib/airtable/config";
// Schema drift is an Airtable-only concern: enumerate via the AIRTABLE control
// registry specifically (controlEnabled), never the PG store.
import { controlEnabled, listOrgRegistry } from "@/lib/platform/controlPlane";
import {
  expectedPlatformSchema,
  readBaseSchema,
  templateBaseId,
} from "@/lib/airtable/provision";
import { prisma } from "@/lib/db";
import { MODULE1_CORE_SCHEMA_VERSION } from "./module1Governance";

export interface OrgDrift {
  slug: string;
  name: string;
  baseId: string | null;
  /** Whether the base schema could be read. */
  reachable: boolean;
  error?: string;
  missingTables: string[];
  missingFieldsByTable: { table: string; fields: string[] }[];
  missingFieldCount: number;
  /** coreVersion recorded in the org registry settings, if any. */
  recordedCoreVersion: string | null;
  /** True when no tables/fields are missing AND the version matches. */
  inSync: boolean;
}

export interface SchemaDriftReport {
  enabled: boolean;
  source: "control-registry" | "postgres" | "none";
  templateBaseId: string;
  expectedCoreVersion: string;
  /** Tables (by name) the report compares against. */
  comparedTables: string[];
  orgs: OrgDrift[];
}

interface OrgRef {
  slug: string;
  name: string;
  baseId: string | null;
  recordedCoreVersion: string | null;
}

function recordedCoreVersionFromSettings(settingsJson: string): string | null {
  try {
    const parsed = JSON.parse(settingsJson) as
      | { module1?: { schema?: { coreVersion?: string } } }
      | null;
    return parsed?.module1?.schema?.coreVersion ?? null;
  } catch {
    return null;
  }
}

async function enumerateOrgs(): Promise<{ source: SchemaDriftReport["source"]; orgs: OrgRef[] }> {
  if (controlEnabled()) {
    const entries = await listOrgRegistry();
    return {
      source: "control-registry",
      orgs: entries.map((e) => ({
        slug: e.slug,
        name: e.name,
        baseId: e.airtableBaseId,
        recordedCoreVersion: recordedCoreVersionFromSettings(e.settings),
      })),
    };
  }
  const rows = await prisma.platOrganisation.findMany({
    select: { slug: true, name: true, airtableBaseId: true, settings: true },
    orderBy: { id: "asc" },
  });
  return {
    source: "postgres",
    orgs: rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      baseId: r.airtableBaseId,
      recordedCoreVersion: recordedCoreVersionFromSettings(r.settings),
    })),
  };
}

async function driftForOrg(
  org: OrgRef,
  expected: Map<string, Set<string>>,
  expectedCoreVersion: string,
): Promise<OrgDrift> {
  const base = {
    slug: org.slug,
    name: org.name,
    baseId: org.baseId,
    recordedCoreVersion: org.recordedCoreVersion,
  };
  if (!org.baseId) {
    return {
      ...base,
      reachable: false,
      error: "no base provisioned",
      missingTables: [],
      missingFieldsByTable: [],
      missingFieldCount: 0,
      inSync: false,
    };
  }
  try {
    const tables = await readBaseSchema(org.baseId);
    const actual = new Map(tables.map((t) => [t.name, new Set(t.fields.map((f) => f.name))]));
    const missingTables: string[] = [];
    const missingFieldsByTable: { table: string; fields: string[] }[] = [];
    for (const [tableName, expectedFields] of expected) {
      const actualFields = actual.get(tableName);
      if (!actualFields) {
        missingTables.push(tableName);
        continue;
      }
      const missing = [...expectedFields].filter((f) => !actualFields.has(f));
      if (missing.length) missingFieldsByTable.push({ table: tableName, fields: missing });
    }
    const missingFieldCount = missingFieldsByTable.reduce((n, x) => n + x.fields.length, 0);
    const versionOk =
      org.recordedCoreVersion === null || org.recordedCoreVersion === expectedCoreVersion;
    return {
      ...base,
      reachable: true,
      missingTables,
      missingFieldsByTable,
      missingFieldCount,
      inSync: missingTables.length === 0 && missingFieldCount === 0 && versionOk,
    };
  } catch (err) {
    return {
      ...base,
      reachable: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 120),
      missingTables: [],
      missingFieldsByTable: [],
      missingFieldCount: 0,
      inSync: false,
    };
  }
}

/** Base ids of every managed org (control registry or Postgres). Used to guard
 *  the migrate action so it can only target a base the platform actually owns. */
export async function listManagedBaseIds(): Promise<Set<string>> {
  if (!airtableEnabled()) return new Set();
  const { orgs } = await enumerateOrgs();
  return new Set(orgs.map((o) => o.baseId).filter((b): b is string => !!b));
}

export async function loadSchemaDrift(): Promise<SchemaDriftReport> {
  const expectedCoreVersion = MODULE1_CORE_SCHEMA_VERSION;
  const template = templateBaseId();
  if (!airtableEnabled()) {
    return {
      enabled: false,
      source: "none",
      templateBaseId: template,
      expectedCoreVersion,
      comparedTables: [],
      orgs: [],
    };
  }

  const templateTables = await readBaseSchema(template);
  const expected = expectedPlatformSchema(templateTables);
  const comparedTables = [...expected.keys()].sort();

  const { source, orgs } = await enumerateOrgs();
  const drifts = await Promise.all(
    orgs.map((o) => driftForOrg(o, expected, expectedCoreVersion)),
  );

  // In-sync first is less useful operationally than drift-first: surface
  // problems at the top.
  drifts.sort((a, b) => Number(a.inSync) - Number(b.inSync));

  return {
    enabled: true,
    source,
    templateBaseId: template,
    expectedCoreVersion,
    comparedTables,
    orgs: drifts,
  };
}
