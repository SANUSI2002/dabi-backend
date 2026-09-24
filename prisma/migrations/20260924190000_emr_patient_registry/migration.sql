CREATE TYPE "EmrPatientSex" AS ENUM ('FEMALE', 'MALE', 'OTHER', 'UNKNOWN');

CREATE TABLE "emr_patients" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "medical_record_number" TEXT NOT NULL,
  "given_name" TEXT NOT NULL,
  "family_name" TEXT NOT NULL,
  "date_of_birth" DATE NOT NULL,
  "sex" "EmrPatientSex" NOT NULL DEFAULT 'UNKNOWN',
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_patients_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "emr_patients_organization_id_medical_record_number_key"
  ON "emr_patients"("organization_id", "medical_record_number");
CREATE INDEX "emr_patients_organization_id_created_at_id_idx"
  ON "emr_patients"("organization_id", "created_at", "id");
ALTER TABLE "emr_patients" ADD CONSTRAINT "emr_patients_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "emr_patients" ADD CONSTRAINT "emr_patients_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('patient.register', 'Register a patient in the member organization')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HOSPITAL_ADMIN', 'patient.read'),
  ('HOSPITAL_ADMIN', 'patient.register'),
  ('RECEPTIONIST', 'patient.read'),
  ('RECEPTIONIST', 'patient.register')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
