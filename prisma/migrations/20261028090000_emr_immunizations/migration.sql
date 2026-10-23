-- Immunization (Maternal & Child Health, part 4): routine EPI doses per child, adverse events
-- following immunization (AEFI), and defaulter tracking (worked out from the schedule in
-- immunizations.policy.js). Each antigen is given once per child; a wrong dose is marked
-- entered-in-error (only while no AEFI is reported against it). Nothing is deleted.

CREATE TABLE "emr_immunizations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "vaccine_code" VARCHAR(12) NOT NULL,
  "vaccine_name" VARCHAR(120) NOT NULL,
  "given_at" TIMESTAMP(3) NOT NULL,
  "batch_number" VARCHAR(60) NOT NULL,
  "site" VARCHAR(60) NOT NULL,
  "given_by_user_id" TEXT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "error_reason" VARCHAR(300),
  "errored_by_user_id" TEXT,
  "errored_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_immunizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_immunizations_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_immunizations_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_immunizations_status_check" CHECK ("status" IN ('ACTIVE', 'ENTERED_IN_ERROR')),
  CONSTRAINT "emr_immunizations_error_check" CHECK (("status" = 'ENTERED_IN_ERROR') = ("error_reason" IS NOT NULL AND "errored_by_user_id" IS NOT NULL AND "errored_at" IS NOT NULL))
);
-- One dose of each antigen per child.
CREATE UNIQUE INDEX "emr_immunizations_one_dose_key" ON "emr_immunizations"("organization_id", "patient_id", "vaccine_code") WHERE "status" = 'ACTIVE';
CREATE INDEX "emr_immunizations_organization_id_given_at_idx" ON "emr_immunizations"("organization_id", "given_at");

CREATE TABLE "emr_aefi_reports" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "immunization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "symptoms" VARCHAR(500) NOT NULL,
  "severity" VARCHAR(12) NOT NULL,
  "onset_hours" INTEGER NOT NULL,
  "action_taken" VARCHAR(500) NOT NULL,
  "reported_by_user_id" TEXT NOT NULL,
  "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_aefi_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_aefi_reports_immunization_key" UNIQUE ("organization_id", "immunization_id"),
  CONSTRAINT "emr_aefi_reports_immunization_fkey" FOREIGN KEY ("organization_id", "immunization_id") REFERENCES "emr_immunizations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_aefi_reports_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_aefi_reports_values_check" CHECK ("severity" IN ('SERIOUS', 'NON_SERIOUS') AND "onset_hours" BETWEEN 0 AND 720)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_immunizations', 'emr_aefi_reports'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON "emr_immunizations" TO sabi_emr_app;
GRANT UPDATE ("status", "error_reason", "errored_by_user_id", "errored_at") ON "emr_immunizations" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_aefi_reports" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('immunization.read', 'View immunizations, defaulters and AEFI reports'),
  ('immunization.give', 'Record vaccine doses and report AEFI')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'immunization.read'), ('DOCTOR', 'immunization.give'),
  ('NURSE', 'immunization.read'), ('NURSE', 'immunization.give'),
  ('HOSPITAL_ADMIN', 'immunization.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
