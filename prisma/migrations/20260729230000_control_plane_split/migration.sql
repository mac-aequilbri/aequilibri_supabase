-- DropForeignKey
ALTER TABLE "plat_cfg_nomenclature" DROP CONSTRAINT "plat_cfg_nomenclature_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_cfg_reference" DROP CONSTRAINT "plat_cfg_reference_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_cfg_region" DROP CONSTRAINT "plat_cfg_region_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_cfg_setting" DROP CONSTRAINT "plat_cfg_setting_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_cfg_teammember" DROP CONSTRAINT "plat_cfg_teammember_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_accountingconnection" DROP CONSTRAINT "plat_con_accountingconnection_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_bimmodel" DROP CONSTRAINT "plat_con_bimmodel_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_budgetline" DROP CONSTRAINT "plat_con_budgetline_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_cashflow" DROP CONSTRAINT "plat_con_cashflow_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_cashflowledger" DROP CONSTRAINT "plat_con_cashflowledger_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_meetingminutes" DROP CONSTRAINT "plat_con_meetingminutes_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_phase" DROP CONSTRAINT "plat_con_phase_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_phaseevidence" DROP CONSTRAINT "plat_con_phaseevidence_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_plantask" DROP CONSTRAINT "plat_con_plantask_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_portaltoken" DROP CONSTRAINT "plat_con_portaltoken_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_procurement" DROP CONSTRAINT "plat_con_procurement_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_quote" DROP CONSTRAINT "plat_con_quote_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_quoteline" DROP CONSTRAINT "plat_con_quoteline_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_risk" DROP CONSTRAINT "plat_con_risk_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_roommatrix" DROP CONSTRAINT "plat_con_roommatrix_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_variationorder" DROP CONSTRAINT "plat_con_variationorder_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_vendor" DROP CONSTRAINT "plat_con_vendor_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_con_weeklyreport" DROP CONSTRAINT "plat_con_weeklyreport_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_actionhub" DROP CONSTRAINT "plat_core_actionhub_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_assessment" DROP CONSTRAINT "plat_core_assessment_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_chatmessage" DROP CONSTRAINT "plat_core_chatmessage_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_chatsession" DROP CONSTRAINT "plat_core_chatsession_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_comms" DROP CONSTRAINT "plat_core_comms_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_contact" DROP CONSTRAINT "plat_core_contact_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_correction" DROP CONSTRAINT "plat_core_correction_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_decision" DROP CONSTRAINT "plat_core_decision_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_document" DROP CONSTRAINT "plat_core_document_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_engagementtypeconfig" DROP CONSTRAINT "plat_core_engagementtypeconfig_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_executionlog" DROP CONSTRAINT "plat_core_executionlog_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_hypothesis" DROP CONSTRAINT "plat_core_hypothesis_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_intelligencesnapshot" DROP CONSTRAINT "plat_core_intelligencesnapshot_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_job" DROP CONSTRAINT "plat_core_job_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_learningrule" DROP CONSTRAINT "plat_core_learningrule_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_pendingwrite" DROP CONSTRAINT "plat_core_pendingwrite_org_id_fkey";

-- DropForeignKey
ALTER TABLE "plat_core_workstream" DROP CONSTRAINT "plat_core_workstream_org_id_fkey";

-- DropTable
DROP TABLE "plat_core_organisation";

-- DropTable
DROP TABLE "plat_ctl_assignment";

-- DropTable
DROP TABLE "plat_ctl_connection";

-- DropTable
DROP TABLE "plat_ctl_job_catalog";

-- DropTable
DROP TABLE "plat_ctl_org_registry";

-- DropTable
DROP TABLE "plat_ctl_outbox";

-- DropTable
DROP TABLE "plat_ctl_report_catalog";

-- DropTable
DROP TABLE "plat_ctl_team";

-- DropTable
DROP TABLE "plat_ctl_template_registry";

