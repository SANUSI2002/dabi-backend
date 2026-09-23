CREATE TYPE "PrescriptionStatus" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');

CREATE TABLE "prescriptions" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "doctor_profile_id" TEXT NOT NULL,
  "status" "PrescriptionStatus" NOT NULL DEFAULT 'DRAFT',
  "instructions" TEXT,
  "issuer_attested_at" TIMESTAMP(3),
  "issued_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "prescription_items" (
  "id" TEXT NOT NULL,
  "prescription_id" TEXT NOT NULL,
  "medication_name" TEXT NOT NULL,
  "dosage" TEXT NOT NULL,
  "frequency" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "duration" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "indication" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "prescription_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "prescriptions_reference_key" ON "prescriptions"("reference");
CREATE INDEX "prescriptions_patient_id_status_issued_at_idx" ON "prescriptions"("patient_id", "status", "issued_at");
CREATE INDEX "prescriptions_doctor_profile_id_status_created_at_idx" ON "prescriptions"("doctor_profile_id", "status", "created_at");
CREATE INDEX "prescription_items_prescription_id_idx" ON "prescription_items"("prescription_id");
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "professional_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "prescription_items" ADD CONSTRAINT "prescription_items_prescription_id_fkey" FOREIGN KEY ("prescription_id") REFERENCES "prescriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
