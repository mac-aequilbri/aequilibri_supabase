-- PlatCtlDomainLabel: Postgres source for vertical field re-labelling
-- (lib/platform/domainLabels). Replaces the retired Airtable DOMAIN_LABELS.
CREATE TABLE "plat_ctl_domain_label" (
    "id" SERIAL NOT NULL,
    "vertical_key" VARCHAR(100) NOT NULL,
    "core_table" VARCHAR(100) NOT NULL,
    "core_field" VARCHAR(200) NOT NULL,
    "label" VARCHAR(200) NOT NULL,
    "context_note" TEXT NOT NULL DEFAULT '',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "plat_ctl_domain_label_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "plat_ctl_domain_label_vertical_key_core_table_core_field_key"
    ON "plat_ctl_domain_label" ("vertical_key", "core_table", "core_field");

CREATE INDEX "plat_ctl_domain_label_vertical_key_is_active_idx"
    ON "plat_ctl_domain_label" ("vertical_key", "is_active");
