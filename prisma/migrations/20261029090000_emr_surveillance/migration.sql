-- Disease surveillance (IDSR): notifiable-disease cases, notified as suspected and then confirmed or
-- discarded by a clinician. A serious AEFI opens a suspected AEFI case automatically and the AEFI
-- report keeps a link to it. Nothing is deleted; a case only changes status, with who and when.

CREATE TABLE "emr_surveillance_cases" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "disease_code" VARCHAR(10) NOT NULL,
  "disease_name" VARCHAR(120) NOT NULL,
  "immediate" BOOLEAN NOT NULL,
  "onset_date" DATE,
  "notes" VARCHAR(1000),
  "source" VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
  "status" VARCHAR(10) NOT NULL DEFAULT 'SUSPECTED',
  "reported_by_user_id" TEXT NOT NULL,
  "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "classified_by_user_id" TEXT,
  "classified_at" TIMESTAMP(3),
  "classification_note" VARCHAR(300),
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_surveillance_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_surveillance_cases_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_surveillance_cases_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_surveillance_cases_values_check" CHECK ("source" IN ('MANUAL', 'AEFI') AND "status" IN ('SUSPECTED', 'CONFIRMED', 'DISCARDED')),
  CONSTRAINT "emr_surveillance_cases_classified_check" CHECK (("status" = 'SUSPECTED') = ("classified_by_user_id" IS NULL AND "classified_at" IS NULL))
);
CREATE INDEX "emr_surveillance_cases_organization_id_reported_at_idx" ON "emr_surveillance_cases"("organization_id", "reported_at");

ALTER TABLE "emr_surveillance_cases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_surveillance_cases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_surveillance_cases_tenant" ON "emr_surveillance_cases" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_surveillance_cases" TO sabi_emr_app;
GRANT UPDATE ("status", "classified_by_user_id", "classified_at", "classification_note", "version", "updated_at") ON "emr_surveillance_cases" TO sabi_emr_app;

-- The AEFI report points to the case it opened (set once, in the same transaction).
ALTER TABLE "emr_aefi_reports" ADD COLUMN "surveillance_case_id" TEXT;
ALTER TABLE "emr_aefi_reports" ADD CONSTRAINT "emr_aefi_reports_case_fkey" FOREIGN KEY ("organization_id", "surveillance_case_id") REFERENCES "emr_surveillance_cases"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
GRANT UPDATE ("surveillance_case_id") ON "emr_aefi_reports" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('surveillance.read', 'View the notifiable-disease line list'),
  ('surveillance.notify', 'Notify suspected notifiable-disease cases'),
  ('surveillance.classify', 'Confirm or discard notified cases')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'surveillance.read'), ('DOCTOR', 'surveillance.notify'), ('DOCTOR', 'surveillance.classify'),
  ('NURSE', 'surveillance.read'), ('NURSE', 'surveillance.notify'),
  ('LAB_SCIENTIST', 'surveillance.read'),
  ('HOSPITAL_ADMIN', 'surveillance.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
