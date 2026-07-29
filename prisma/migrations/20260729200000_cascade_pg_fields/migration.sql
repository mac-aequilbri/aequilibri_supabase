-- AlterTable
ALTER TABLE "plat_con_phase" ADD COLUMN     "rag" VARCHAR(10) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "plat_core_actionhub" ADD COLUMN     "issue_type" VARCHAR(50) NOT NULL DEFAULT 'Open Action',
ADD COLUMN     "phase_id" INTEGER,
ADD COLUMN     "risk_id" INTEGER;

