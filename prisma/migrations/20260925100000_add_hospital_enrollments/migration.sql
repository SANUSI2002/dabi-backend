CREATE TYPE "HospitalEnrollmentStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED');

CREATE TABLE "hospital_enrollments" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "hospital_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "HospitalEnrollmentStatus" NOT NULL DEFAULT 'PENDING',
    "patient_note" VARCHAR(500),
    "decision_reason" VARCHAR(500),
    "decided_at" TIMESTAMP(3),
    "decided_by_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hospital_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hospital_enrollments_patient_id_created_at_idx" ON "hospital_enrollments"("patient_id", "created_at");
CREATE INDEX "hospital_enrollments_hospital_id_status_created_at_idx" ON "hospital_enrollments"("hospital_id", "status", "created_at");
-- PostgreSQL partial index permits re-application after a rejected decision.
CREATE UNIQUE INDEX "hospital_enrollments_open_subject_hospital_key" ON "hospital_enrollments"("patient_id", "hospital_id") WHERE "status" IN ('PENDING', 'ACTIVE');

ALTER TABLE "hospital_enrollments" ADD CONSTRAINT "hospital_enrollments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hospital_enrollments" ADD CONSTRAINT "hospital_enrollments_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hospital_enrollments" ADD CONSTRAINT "hospital_enrollments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "hospital_member_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hospital_enrollments" ADD CONSTRAINT "hospital_enrollments_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
