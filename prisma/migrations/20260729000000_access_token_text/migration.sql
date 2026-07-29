-- Phase 0 drift fix: schema.prisma declares accessToken as @db.Text but the
-- baseline migration created VARCHAR(500) (schema was changed without a
-- migration — encrypted OAuth tokens exceed 500 chars). Detected by
-- `prisma migrate diff` on the first-ever real application of the migration
-- history (2026-07-29).
ALTER TABLE "plat_con_accountingconnection" ALTER COLUMN "access_token" SET DATA TYPE TEXT;
