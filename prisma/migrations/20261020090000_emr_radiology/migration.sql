-- Radiology: imaging studies (request → schedule → perform → report → verify → addenda), their
-- series and reports. No images are stored: no PACS/DICOM viewer is connected. Never deleted.
ALTER TYPE "EmrChargeCategory" ADD VALUE IF NOT EXISTS 'IMAGING';
-- Performed studies are billed like lab tests: one charge per study (source IMAGING_STUDY).
ALTER TABLE "emr_charges" DROP CONSTRAINT "emr_charges_source_check";
ALTER TABLE "emr_charges" ADD CONSTRAINT "emr_charges_source_check"
  CHECK ("source_type" IN ('ENCOUNTER', 'LAB_ORDER_ITEM', 'LAB_CANCELLED', 'IMAGING_STUDY', 'DISPENSE_LINE', 'DISPENSE_RETURN', 'BED_DAY', 'MANUAL')) NOT VALID;
ALTER TABLE "emr_charges" VALIDATE CONSTRAINT "emr_charges_source_check";

CREATE TABLE "emr_imaging_studies" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "encounter_id" TEXT,
  "accession_number" VARCHAR(20) NOT NULL,
  "modality" VARCHAR(20) NOT NULL,
  "body_site" VARCHAR(120) NOT NULL,
  "laterality" VARCHAR(10),
  "indication" VARCHAR(500) NOT NULL,
  "priority" VARCHAR(10) NOT NULL DEFAULT 'ROUTINE',
  "preparation" VARCHAR(200),
  "external_study" BOOLEAN NOT NULL DEFAULT false,
  "status" VARCHAR(12) NOT NULL DEFAULT 'REQUESTED',
  "requested_by_user_id" TEXT NOT NULL,
  "scheduled_for" DATE,
  "scheduled_by_user_id" TEXT,
  "performed_at" TIMESTAMP(3),
  "performed_by_user_id" TEXT,
  "cancelled_at" TIMESTAMP(3),
  "cancelled_by_user_id" TEXT,
  "cancellation_reason" VARCHAR(300),
  "compare_to_study_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_imaging_studies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_imaging_studies_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_imaging_studies_accession_key" UNIQUE ("organization_id", "accession_number"),
  CONSTRAINT "emr_imaging_studies_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_imaging_studies_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_imaging_studies_compare_fkey" FOREIGN KEY ("organization_id", "compare_to_study_id") REFERENCES "emr_imaging_studies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_imaging_studies_modality_check" CHECK ("modality" IN ('XRAY', 'ULTRASOUND', 'CT', 'MRI', 'MAMMOGRAPHY', 'FLUOROSCOPY')),
  CONSTRAINT "emr_imaging_studies_laterality_check" CHECK ("laterality" IS NULL OR "laterality" IN ('LEFT', 'RIGHT', 'BILATERAL')),
  CONSTRAINT "emr_imaging_studies_priority_check" CHECK ("priority" IN ('ROUTINE', 'URGENT', 'EMERGENCY')),
  CONSTRAINT "emr_imaging_studies_status_check" CHECK ("status" IN ('REQUESTED', 'SCHEDULED', 'PERFORMED', 'REPORTED', 'VERIFIED', 'AMENDED', 'CANCELLED')),
  CONSTRAINT "emr_imaging_studies_not_self_check" CHECK ("compare_to_study_id" IS NULL OR "compare_to_study_id" <> "id"),
  -- Who and when travel with each step.
  CONSTRAINT "emr_imaging_studies_steps_check" CHECK (
    ("status" <> 'SCHEDULED' OR ("scheduled_for" IS NOT NULL AND "scheduled_by_user_id" IS NOT NULL)) AND
    ("status" NOT IN ('PERFORMED', 'REPORTED', 'VERIFIED', 'AMENDED') OR ("performed_at" IS NOT NULL AND "performed_by_user_id" IS NOT NULL)) AND
    ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL))
  )
);
CREATE INDEX "emr_imaging_studies_organization_id_created_at_id_idx" ON "emr_imaging_studies"("organization_id", "created_at", "id");
CREATE INDEX "emr_imaging_studies_organization_id_patient_id_created_at_idx" ON "emr_imaging_studies"("organization_id", "patient_id", "created_at");
CREATE INDEX "emr_imaging_studies_encounter_idx" ON "emr_imaging_studies"("organization_id", "encounter_id") WHERE "encounter_id" IS NOT NULL;

CREATE TABLE "emr_imaging_series" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "study_id" TEXT NOT NULL,
  "series_number" INTEGER NOT NULL,
  "description" VARCHAR(120) NOT NULL,
  "body_part" VARCHAR(120) NOT NULL,
  "image_count" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_imaging_series_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_imaging_series_number_key" UNIQUE ("organization_id", "study_id", "series_number"),
  CONSTRAINT "emr_imaging_series_study_fkey" FOREIGN KEY ("organization_id", "study_id") REFERENCES "emr_imaging_studies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_imaging_series_count_check" CHECK ("series_number" > 0 AND ("image_count" IS NULL OR "image_count" > 0))
);

CREATE TABLE "emr_imaging_reports" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "study_id" TEXT NOT NULL,
  "findings" VARCHAR(5000) NOT NULL,
  "impression" VARCHAR(1000) NOT NULL,
  "author_user_id" TEXT NOT NULL,
  "authored_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verified_by_user_id" TEXT,
  "verified_at" TIMESTAMP(3),
  CONSTRAINT "emr_imaging_reports_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_imaging_reports_study_key" UNIQUE ("organization_id", "study_id"),
  CONSTRAINT "emr_imaging_reports_study_fkey" FOREIGN KEY ("organization_id", "study_id") REFERENCES "emr_imaging_studies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_imaging_reports_verified_check" CHECK (("verified_by_user_id" IS NULL) = ("verified_at" IS NULL))
);

CREATE TABLE "emr_imaging_addenda" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "study_id" TEXT NOT NULL,
  "note" VARCHAR(2000) NOT NULL,
  "author_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_imaging_addenda_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_imaging_addenda_study_fkey" FOREIGN KEY ("organization_id", "study_id") REFERENCES "emr_imaging_studies"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "emr_imaging_addenda_organization_id_study_id_created_at_idx" ON "emr_imaging_addenda"("organization_id", "study_id", "created_at");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_imaging_studies', 'emr_imaging_series', 'emr_imaging_reports', 'emr_imaging_addenda'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

-- No DELETE anywhere. What was requested never changes; series and addenda are append-only; a
-- report's text is fixed once written (only its verification is added).
GRANT SELECT, INSERT ON "emr_imaging_studies" TO sabi_emr_app;
GRANT UPDATE ("status", "scheduled_for", "scheduled_by_user_id", "performed_at", "performed_by_user_id", "cancelled_at",
  "cancelled_by_user_id", "cancellation_reason", "compare_to_study_id", "version", "updated_at") ON "emr_imaging_studies" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_imaging_series" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_imaging_reports" TO sabi_emr_app;
GRANT UPDATE ("verified_by_user_id", "verified_at") ON "emr_imaging_reports" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_imaging_addenda" TO sabi_emr_app;

-- Roles and permissions.
INSERT INTO "access_roles" ("code", "scope", "description") VALUES
  ('RADIOGRAPHER', 'ORGANIZATION', 'Radiographer (performs imaging)'),
  ('RADIOLOGIST', 'ORGANIZATION', 'Radiologist (reports imaging)')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('imaging.read', 'View imaging studies and reports'),
  ('imaging.order.create', 'Request imaging'),
  ('imaging.perform', 'Schedule and perform imaging studies'),
  ('imaging.report', 'Write, verify and add to imaging reports')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'imaging.read'),
  ('DOCTOR', 'imaging.order.create'),
  ('NURSE', 'imaging.read'),
  ('NURSE', 'imaging.order.create'),
  ('RADIOGRAPHER', 'imaging.read'),
  ('RADIOGRAPHER', 'imaging.perform'),
  ('RADIOGRAPHER', 'patient.read'),
  ('RADIOGRAPHER', 'queue.read'),
  ('RADIOLOGIST', 'imaging.read'),
  ('RADIOLOGIST', 'imaging.perform'),
  ('RADIOLOGIST', 'imaging.report'),
  ('RADIOLOGIST', 'patient.read'),
  ('RADIOLOGIST', 'clinical.read'),
  ('RADIOLOGIST', 'queue.read'),
  ('HOSPITAL_ADMIN', 'imaging.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
