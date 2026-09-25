ALTER TABLE "hospital_enrollments" ADD COLUMN "dependent_id" TEXT;
ALTER TABLE "hospital_appointments" ADD COLUMN "dependent_id" TEXT;
CREATE INDEX "hospital_enrollments_patient_id_dependent_id_created_at_idx" ON "hospital_enrollments"("patient_id", "dependent_id", "created_at");
CREATE INDEX "hospital_enrollments_dependent_id_hospital_id_status_idx" ON "hospital_enrollments"("dependent_id", "hospital_id", "status");
CREATE INDEX "hospital_appointments_patient_id_dependent_id_created_at_idx" ON "hospital_appointments"("patient_id", "dependent_id", "created_at");
CREATE INDEX "hospital_appointments_dependent_id_requested_at_idx" ON "hospital_appointments"("dependent_id", "requested_at");
ALTER TABLE "hospital_enrollments" ADD CONSTRAINT "hospital_enrollments_dependent_id_fkey" FOREIGN KEY ("dependent_id") REFERENCES "dependent_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hospital_appointments" ADD CONSTRAINT "hospital_appointments_dependent_id_fkey" FOREIGN KEY ("dependent_id") REFERENCES "dependent_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
