// Platform core — shared types for the three-tier architecture.
// Choice fields are string-literal unions (the DB stores varchar, not enums),
// matching the convention used across the Uc* schemas.

export type EngagementType = "short_job" | "long_project" | "ongoing" | "seasonal" | "general";

/** How much write authority the org grants the AI assistant. */
export type AiAuthority = "propose_only" | "approve_required" | "auto_low_risk";

export type ActorType = "ai" | "human" | "system";

export type ExecStatus = "proposed" | "approved" | "executed" | "rejected" | "failed";

import type { Module1Governance } from "./module1Governance";

/** Parsed PlatOrganisation.settings. */
export interface OrgConfig {
  assistant: { name: string; persona: string };
  features: Record<string, boolean>;
  module1?: Module1Governance;
  /** Customer branding captured at onboarding. `logo` is a data URL (stored
   *  inline in settings so it works across the Airtable/Postgres stores). */
  branding?: { logo?: string };
  /** Rec id of the org's "General" project — the shared bucket for org-level
   *  records. RLS always keeps it in scope so every member sees it. Set at
   *  provisioning; absent until then (docs/archive/project-general-bucket-plan.md). */
  generalJobId?: string;
  /** §2b: the org's own tenant-database connection string, set when its
   *  database is provisioned (scripts/provision-tenant-db.mjs). Absent = the
   *  org lives in the shared/default tenant DB (DATABASE_URL). Resolved by
   *  db(ctx) in lib/db.ts. Do NOT flip this before the prisma.* → db(ctx)
   *  call-site sweep is complete — a partial sweep splits reads/writes
   *  across two databases. */
  tenantDatabaseUrl?: string;
}

/** Request context every platform service takes as its first argument. */
export interface OrgCtx {
  orgId: number;
  orgSlug: string;
  orgName: string;
  vertical: string;
  defaultEngagementType: EngagementType;
  allowedEngagementTypes: EngagementType[];
  aiAuthority: AiAuthority;
  config: OrgConfig;
}

export interface Actor {
  type: ActorType;
  name: string;
  role?: string;
  /** Chat message that produced this write, for provenance. */
  sourceMessageId?: number;
}

/** Feature flags that gate nav items and screens; org settings override these. */
export const DEFAULT_FEATURES: Record<string, boolean> = {
  // Standalone conversational chat, surfaced as its own screen at /chat and
  // independent of the project-delivery ("UC3") module bundle. On by default so
  // every onboarded org gets it; turn it off per-org to withhold the feature.
  chat: true,
  risks: true,
  variations: true,
  quotes: true,
  reports: true,
  meeting_minutes: true,
  documents: true,
  portal: true,
  accounting: false,
  bim: true,
  delay_cascade: false,
  procurement: false,
  room_matrix: false,
  project_plan: false,
  vendors: true,
  learning_rules: true,
  // Backend-switch Phase D: per-org data-backend override. When true, this
  // org's reads/writes use Postgres even while AIRTABLE_MIGRATION is on
  // globally (opt-OUT of Airtable; the reverse — forcing Airtable while the
  // global flag is off — is not supported). Consumed by airtableEnabled(ctx);
  // requires the org's rows to exist in Postgres (scripts/migration/).
  data_backend_postgres: false,
};
