-- DropIndex
DROP INDEX "plat_cfg_nomenclature_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_cfg_reference_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_cfg_region_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_cfg_setting_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_cfg_teammember_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_accountingconnection_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_bimmodel_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_budgetline_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_cashflow_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_meetingminutes_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_phase_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_phaseevidence_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_plantask_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_portaltoken_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_procurement_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_quote_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_quoteline_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_risk_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_roommatrix_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_variationorder_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_vendor_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_con_weeklyreport_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_actionhub_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_assessment_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_chatmessage_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_chatsession_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_comms_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_contact_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_correction_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_decision_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_document_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_engagementtypeconfig_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_executionlog_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_hypothesis_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_intelligencesnapshot_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_job_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_learningrule_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_pendingwrite_airtable_record_id_key";

-- DropIndex
DROP INDEX "plat_core_workstream_airtable_record_id_key";

-- CreateIndex
CREATE UNIQUE INDEX "plat_cfg_nomenclature_org_id_airtable_record_id_key" ON "plat_cfg_nomenclature"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_cfg_reference_org_id_airtable_record_id_key" ON "plat_cfg_reference"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_cfg_region_org_id_airtable_record_id_key" ON "plat_cfg_region"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_cfg_setting_org_id_airtable_record_id_key" ON "plat_cfg_setting"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_cfg_teammember_org_id_airtable_record_id_key" ON "plat_cfg_teammember"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_accountingconnection_org_id_airtable_record_id_key" ON "plat_con_accountingconnection"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_bimmodel_org_id_airtable_record_id_key" ON "plat_con_bimmodel"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_budgetline_org_id_airtable_record_id_key" ON "plat_con_budgetline"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_cashflow_org_id_airtable_record_id_key" ON "plat_con_cashflow"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_meetingminutes_org_id_airtable_record_id_key" ON "plat_con_meetingminutes"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_phase_org_id_airtable_record_id_key" ON "plat_con_phase"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_phaseevidence_org_id_airtable_record_id_key" ON "plat_con_phaseevidence"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_plantask_org_id_airtable_record_id_key" ON "plat_con_plantask"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_portaltoken_org_id_airtable_record_id_key" ON "plat_con_portaltoken"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_procurement_org_id_airtable_record_id_key" ON "plat_con_procurement"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_quote_org_id_airtable_record_id_key" ON "plat_con_quote"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_quoteline_org_id_airtable_record_id_key" ON "plat_con_quoteline"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_risk_org_id_airtable_record_id_key" ON "plat_con_risk"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_roommatrix_org_id_airtable_record_id_key" ON "plat_con_roommatrix"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_variationorder_org_id_airtable_record_id_key" ON "plat_con_variationorder"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_vendor_org_id_airtable_record_id_key" ON "plat_con_vendor"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_con_weeklyreport_org_id_airtable_record_id_key" ON "plat_con_weeklyreport"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_actionhub_org_id_airtable_record_id_key" ON "plat_core_actionhub"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_assessment_org_id_airtable_record_id_key" ON "plat_core_assessment"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_chatmessage_org_id_airtable_record_id_key" ON "plat_core_chatmessage"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_chatsession_org_id_airtable_record_id_key" ON "plat_core_chatsession"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_comms_org_id_airtable_record_id_key" ON "plat_core_comms"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_contact_org_id_airtable_record_id_key" ON "plat_core_contact"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_correction_org_id_airtable_record_id_key" ON "plat_core_correction"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_decision_org_id_airtable_record_id_key" ON "plat_core_decision"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_document_org_id_airtable_record_id_key" ON "plat_core_document"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_engagementtypeconfig_org_id_airtable_record_id_key" ON "plat_core_engagementtypeconfig"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_executionlog_org_id_airtable_record_id_key" ON "plat_core_executionlog"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_hypothesis_org_id_airtable_record_id_key" ON "plat_core_hypothesis"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_intelligencesnapshot_org_id_airtable_record_id_key" ON "plat_core_intelligencesnapshot"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_job_org_id_airtable_record_id_key" ON "plat_core_job"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_learningrule_org_id_airtable_record_id_key" ON "plat_core_learningrule"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_pendingwrite_org_id_airtable_record_id_key" ON "plat_core_pendingwrite"("org_id", "airtable_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "plat_core_workstream_org_id_airtable_record_id_key" ON "plat_core_workstream"("org_id", "airtable_record_id");

