// Schema drift was an Airtable-only concern: customer bases were clones of the
// template and drifted as the template's schema evolved. The Airtable backend
// is decommissioned (migration-plan Phase 6), so the report is permanently
// empty. The exported types remain so the schema-drift route keeps compiling.

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

/** Retired with the Airtable backend — the platform manages no bases. */
export async function listManagedBaseIds(): Promise<Set<string>> {
  return new Set();
}

/** Retired with the Airtable backend — always the empty, disabled report. */
export async function loadSchemaDrift(): Promise<SchemaDriftReport> {
  return {
    enabled: false,
    source: "none",
    templateBaseId: "",
    expectedCoreVersion: MODULE1_CORE_SCHEMA_VERSION,
    comparedTables: [],
    orgs: [],
  };
}
