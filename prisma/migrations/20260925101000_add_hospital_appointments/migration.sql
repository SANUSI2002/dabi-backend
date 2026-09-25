CREATE TYPE "HospitalAppointmentStatus" AS ENUM ('PENDING', 'SCHEDULED', 'REJECTED', 'CHECKED_IN', 'CANCELLED');

CREATE TABLE "hospital_appointments" (
  "id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "hospital_id" TEXT NOT NULL,
  "enrollment_id" TEXT,
  "status" "HospitalAppointmentStatus" NOT NULL DEFAULT 'PENDING',
  "requested_at" TIMESTAMP(3) NOT NULL,
  "appointment_type" VARCHAR(80),
  "reason" VARCHAR(300),
  "decision_reason" VARCHAR(300),
  "decided_at" TIMESTAMP(3),
  "decided_by_user_id" TEXT,
  "checked_in_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "hospital_appointments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "hospital_appointments_patient_id_created_at_idx" ON "hospital_appointments"("patient_id", "created_at");
CREATE INDEX "hospital_appointments_hospital_id_status_requested_at_idx" ON "hospital_appointments"("hospital_id", "status", "requested_at");
CREATE INDEX "hospital_appointments_status_requested_at_idx" ON "hospital_appointments"("status", "requested_at");
ALTER TABLE "hospital_appointments" ADD CONSTRAINT "hospital_appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hospital_appointments" ADD CONSTRAINT "hospital_appointments_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "hospital_appointments" ADD CONSTRAINT "hospital_appointments_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "hospital_enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "hospital_appointments" ADD CONSTRAINT "hospital_appointments_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
