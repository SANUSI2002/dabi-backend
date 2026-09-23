ALTER TYPE "UserRoleType" ADD VALUE IF NOT EXISTS 'PHARMACY_ADMIN';
ALTER TYPE "UserRoleType" ADD VALUE IF NOT EXISTS 'PHARMACY_COMPLIANCE_ADMIN';
CREATE TYPE "PharmacyComplianceStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED');

CREATE TABLE "pharmacies" (
  "id" TEXT NOT NULL, "admin_user_id" TEXT NOT NULL, "name" TEXT NOT NULL, "address" TEXT NOT NULL,
  "country" TEXT NOT NULL, "state" TEXT NOT NULL, "city" TEXT NOT NULL, "contact_email" TEXT NOT NULL,
  "contact_phone" TEXT NOT NULL, "compliance_status" "PharmacyComplianceStatus" NOT NULL DEFAULT 'PENDING',
  "decision_note" TEXT, "decided_by_user_id" TEXT, "decided_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pharmacies_admin_user_id_key" ON "pharmacies"("admin_user_id");
CREATE INDEX "pharmacies_compliance_status_idx" ON "pharmacies"("compliance_status");
CREATE INDEX "pharmacies_country_state_city_compliance_status_idx" ON "pharmacies"("country", "state", "city", "compliance_status");
ALTER TABLE "pharmacies" ADD CONSTRAINT "pharmacies_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pharmacies" ADD CONSTRAINT "pharmacies_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
