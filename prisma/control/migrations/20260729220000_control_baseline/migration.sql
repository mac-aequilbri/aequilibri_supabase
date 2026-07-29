-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "plat_core_organisation" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "slug" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "vertical" VARCHAR(50) NOT NULL DEFAULT 'construction',
    "default_engagement_type" VARCHAR(30) NOT NULL DEFAULT 'long_project',
    "allowed_engagement_types" TEXT NOT NULL DEFAULT '[]',
    "ai_authority" VARCHAR(30) NOT NULL DEFAULT 'approve_required',
    "settings" TEXT NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "airtable_base_id" VARCHAR(20),

    CONSTRAINT "plat_core_organisation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plat_ctl_org_registry" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "slug" VARCHAR(100) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "org_id" INTEGER,
    "vertical" VARCHAR(50) NOT NULL DEFAULT 'construction',
    "default_engagement_type" VARCHAR(30) NOT NULL DEFAULT 'long_project',
    "allowed_engagement_types" TEXT NOT NULL DEFAULT '[]',
    "ai_authority" VARCHAR(30) NOT NULL DEFAULT 'approve_required',
    "settings" TEXT NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "airtable_base_id" VARCHAR(20),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plat_ctl_org_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plat_ctl_team" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "org_slug" VARCHAR(100) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "name" VARCHAR(200) NOT NULL DEFAULT '',
    "role" VARCHAR(30) NOT NULL DEFAULT 'member',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plat_ctl_team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plat_ctl_assignment" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "org_slug" VARCHAR(100) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "job_rec_id" VARCHAR(20) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plat_ctl_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plat_ctl_connection" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "org_slug" VARCHAR(100) NOT NULL,
    "channel" VARCHAR(50) NOT NULL DEFAULT '',
    "direction" VARCHAR(10) NOT NULL DEFAULT 'in',
    "connection_key" VARCHAR(200) NOT NULL DEFAULT '',
    "credential_ref" VARCHAR(200) NOT NULL DEFAULT '',
    "event_filter" VARCHAR(200) NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_event_at" TIMESTAMP(3),
    "last_status" VARCHAR(100) NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plat_ctl_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plat_ctl_outbox" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "org_slug" VARCHAR(100) NOT NULL,
    "event" VARCHAR(100) NOT NULL DEFAULT '',
    "entity_type" VARCHAR(50) NOT NULL DEFAULT '',
    "entity_id" VARCHAR(20) NOT NULL DEFAULT '',
    "job_id" VARCHAR(20) NOT NULL DEFAULT '',
    "payload" TEXT NOT NULL DEFAULT '{}',
    "summary" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT NOT NULL DEFAULT '',
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plat_ctl_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plat_ctl_report_catalog" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "org_slug" VARCHAR(100) NOT NULL,
    "key" VARCHAR(100) NOT NULL,
    "title" VARCHAR(300) NOT NULL DEFAULT '',
    "prompt" TEXT NOT NULL DEFAULT '',
    "scopes" VARCHAR(200) NOT NULL DEFAULT '',
    "source" VARCHAR(30) NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plat_ctl_report_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plat_ctl_template_registry" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "vertical_key" VARCHAR(100) NOT NULL,
    "industry" VARCHAR(100) NOT NULL DEFAULT '',
    "sub_industry" VARCHAR(100) NOT NULL DEFAULT '',
    "template_base_id" VARCHAR(20) NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plat_ctl_template_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plat_ctl_job_catalog" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "vertical_key" VARCHAR(100) NOT NULL,
    "engagement_type" VARCHAR(30) NOT NULL DEFAULT '',
    "key" VARCHAR(100) NOT NULL,
    "label" VARCHAR(200) NOT NULL DEFAULT '',
    "category_group" VARCHAR(100) NOT NULL DEFAULT '',
    "phases" TEXT NOT NULL DEFAULT '[]',
    "scope_hint" TEXT NOT NULL DEFAULT '',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "source" VARCHAR(30) NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plat_ctl_job_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_organisation_airtable_record_id_key" ON "plat_core_organisation"("airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_organisation_slug_key" ON "plat_core_organisation"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_org_registry_airtable_record_id_key" ON "plat_ctl_org_registry"("airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_org_registry_slug_key" ON "plat_ctl_org_registry"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_team_airtable_record_id_key" ON "plat_ctl_team"("airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_team_org_slug_email_key" ON "plat_ctl_team"("org_slug", "email");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_assignment_airtable_record_id_key" ON "plat_ctl_assignment"("airtable_record_id");

-- CreateIndex
CREATE INDEX "plat_ctl_assignment_org_slug_email_idx" ON "plat_ctl_assignment"("org_slug", "email");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_connection_airtable_record_id_key" ON "plat_ctl_connection"("airtable_record_id");

-- CreateIndex
CREATE INDEX "plat_ctl_connection_org_slug_is_active_idx" ON "plat_ctl_connection"("org_slug", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_outbox_airtable_record_id_key" ON "plat_ctl_outbox"("airtable_record_id");

-- CreateIndex
CREATE INDEX "plat_ctl_outbox_org_slug_status_idx" ON "plat_ctl_outbox"("org_slug", "status");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_report_catalog_airtable_record_id_key" ON "plat_ctl_report_catalog"("airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_report_catalog_org_slug_key_key" ON "plat_ctl_report_catalog"("org_slug", "key");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_template_registry_airtable_record_id_key" ON "plat_ctl_template_registry"("airtable_record_id");

-- CreateIndex
CREATE INDEX "plat_ctl_template_registry_vertical_key_is_active_idx" ON "plat_ctl_template_registry"("vertical_key", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "plat_ctl_job_catalog_airtable_record_id_key" ON "plat_ctl_job_catalog"("airtable_record_id");

-- CreateIndex
CREATE INDEX "plat_ctl_job_catalog_vertical_key_key_idx" ON "plat_ctl_job_catalog"("vertical_key", "key");

