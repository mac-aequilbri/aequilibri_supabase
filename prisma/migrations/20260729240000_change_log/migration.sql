-- CreateTable
CREATE TABLE "plat_con_changelog" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "org_id" INTEGER NOT NULL,
    "job_id" INTEGER,
    "phase_id" INTEGER,
    "linked_issue_id" INTEGER,
    "name" VARCHAR(300) NOT NULL DEFAULT '',
    "change_type" VARCHAR(50) NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "status" VARCHAR(30) NOT NULL DEFAULT '',
    "impact_cost" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "impact_days" INTEGER NOT NULL DEFAULT 0,
    "date_raised" DATE,
    "date_resolved" DATE,
    "raised_by" VARCHAR(200) NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plat_con_changelog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plat_con_changelog_org_id_change_type_idx" ON "plat_con_changelog"("org_id", "change_type");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_changelog_org_id_airtable_record_id_key" ON "plat_con_changelog"("org_id", "airtable_record_id");

