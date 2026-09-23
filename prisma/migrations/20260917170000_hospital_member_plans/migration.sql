-- CreateEnum
CREATE TYPE "HospitalMemberPlanStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateTable
CREATE TABLE "hospital_member_plans" (
    "id" TEXT NOT NULL,
    "hospital_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "fee_minor" INTEGER NOT NULL,
    "status" "HospitalMemberPlanStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "hospital_member_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hospital_member_plans_hospital_id_status_created_at_idx" ON "hospital_member_plans"("hospital_id", "status", "created_at");

-- AddForeignKey
ALTER TABLE "hospital_member_plans" ADD CONSTRAINT "hospital_member_plans_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Fees are integer kobo and cannot be negative.
ALTER TABLE "hospital_member_plans" ADD CONSTRAINT "hospital_member_plans_fee_nonnegative" CHECK ("fee_minor" >= 0);
