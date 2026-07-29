-- CreateTable
CREATE TABLE "plat_con_cashflowledger" (
    "id" SERIAL NOT NULL,
    "airtable_record_id" VARCHAR(20),
    "org_id" INTEGER NOT NULL,
    "job_id" INTEGER NOT NULL,
    "name" VARCHAR(200) NOT NULL DEFAULT '',
    "period" VARCHAR(7) NOT NULL,
    "type" VARCHAR(3) NOT NULL DEFAULT 'Out',
    "amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "source_or_payee" VARCHAR(200) NOT NULL DEFAULT '',
    "category" VARCHAR(100) NOT NULL DEFAULT '',
    "status" VARCHAR(20) NOT NULL DEFAULT 'Forecast',
    "notes" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plat_con_cashflowledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plat_con_cashflowledger_org_id_status_idx" ON "plat_con_cashflowledger"("org_id", "status");

-- CreateIndex
CREATE INDEX "plat_con_cashflowledger_job_id_period_idx" ON "plat_con_cashflowledger"("job_id", "period");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_cashflowledger_org_id_airtable_record_id_key" ON "plat_con_cashflowledger"("org_id", "airtable_record_id");

-- AddForeignKey
ALTER TABLE "plat_con_cashflowledger" ADD CONSTRAINT "plat_con_cashflowledger_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "plat_core_organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plat_con_cashflowledger" ADD CONSTRAINT "plat_con_cashflowledger_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "plat_core_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

