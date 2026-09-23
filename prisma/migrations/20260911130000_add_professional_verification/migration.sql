ALTER TYPE "UserRoleType" ADD VALUE IF NOT EXISTS 'PROFESSIONAL';
ALTER TYPE "UserRoleType" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
CREATE TYPE "ProfessionalVerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED');
CREATE TABLE "professional_profiles" (
  "id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "profession_type" TEXT NOT NULL,
  "registration_number" TEXT NOT NULL, "practice_name" TEXT, "specialty" TEXT,
  "onboarding_progress" INTEGER NOT NULL DEFAULT 0,
  "verification_status" "ProfessionalVerificationStatus" NOT NULL DEFAULT 'PENDING',
  "decision_reason" TEXT, "decided_by_user_id" TEXT, "decided_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "professional_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "professional_profiles_user_id_key" ON "professional_profiles"("user_id");
CREATE INDEX "professional_profiles_verification_status_idx" ON "professional_profiles"("verification_status");
CREATE INDEX "professional_profiles_profession_type_idx" ON "professional_profiles"("profession_type");
ALTER TABLE "professional_profiles" ADD CONSTRAINT "professional_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
