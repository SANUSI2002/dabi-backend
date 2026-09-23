CREATE TYPE "DoctorCareStatus" AS ENUM ('PENDING', 'ACTIVE', 'DECLINED', 'REVOKED', 'EXPIRED');
CREATE TABLE "doctor_care_relationships" ("id" TEXT NOT NULL, "patient_id" TEXT NOT NULL, "doctor_profile_id" TEXT NOT NULL, "status" "DoctorCareStatus" NOT NULL DEFAULT 'PENDING', "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "responded_at" TIMESTAMP(3), "revoked_at" TIMESTAMP(3), "expires_at" TIMESTAMP(3), CONSTRAINT "doctor_care_relationships_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "doctor_care_relationships_patient_id_doctor_profile_id_key" ON "doctor_care_relationships"("patient_id", "doctor_profile_id");
CREATE INDEX "doctor_care_relationships_patient_id_status_idx" ON "doctor_care_relationships"("patient_id", "status");
CREATE INDEX "doctor_care_relationships_doctor_profile_id_status_idx" ON "doctor_care_relationships"("doctor_profile_id", "status");
ALTER TABLE "doctor_care_relationships" ADD CONSTRAINT "doctor_care_relationships_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "doctor_care_relationships" ADD CONSTRAINT "doctor_care_relationships_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "professional_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
