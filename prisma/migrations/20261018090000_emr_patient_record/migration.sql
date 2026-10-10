-- The patient record: richer allergy details and the patient's problem list.

-- ---------------------------------------------------------------------------------------------
-- Allergies: category, criticality, verification, reaction manifestations, note and source.
-- Existing entries were recorded by clinicians as known allergies, so they stay CONFIRMED.
-- Only the verification columns may change afterwards (confirming an unconfirmed entry).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "emr_patient_allergies"
  ADD COLUMN "category" VARCHAR(20),
  ADD COLUMN "criticality" VARCHAR(20),
  ADD COLUMN "verification_status" VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
  ADD COLUMN "manifestations" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "note" VARCHAR(500),
  ADD COLUMN "source" VARCHAR(120),
  ADD COLUMN "verified_by_user_id" TEXT,
  ADD COLUMN "verified_at" TIMESTAMP(3),
  ADD CONSTRAINT "emr_patient_allergies_category_check" CHECK ("category" IS NULL OR "category" IN ('MEDICATION', 'FOOD', 'ENVIRONMENT', 'BIOLOGIC')),
  ADD CONSTRAINT "emr_patient_allergies_criticality_check" CHECK ("criticality" IS NULL OR "criticality" IN ('LOW', 'HIGH', 'UNABLE_TO_ASSESS')),
  ADD CONSTRAINT "emr_patient_allergies_verification_check" CHECK ("verification_status" IN ('UNCONFIRMED', 'PRESUMED', 'CONFIRMED'));
GRANT UPDATE ("verification_status", "verified_by_user_id", "verified_at") ON "emr_patient_allergies" TO sabi_emr_app;

-- ---------------------------------------------------------------------------------------------
-- Problem list. One entry per code per patient: a condition that comes back is set to
-- RECURRENCE or RELAPSE rather than listed twice. Entries are never deleted; a wrong one is
-- set to REFUTED.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_problems" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "encounter_id" TEXT,
  "source_diagnosis_id" TEXT,
  "code" VARCHAR(20) NOT NULL,
  "code_system" VARCHAR(10) NOT NULL,
  "description" VARCHAR(300) NOT NULL,
  "clinical_status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "verification_status" VARCHAR(20) NOT NULL DEFAULT 'PROVISIONAL',
  "onset_date" DATE,
  "abatement_date" DATE,
  "note" VARCHAR(1000),
  "recorded_by_user_id" TEXT NOT NULL,
  "updated_by_user_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_problems_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_problems_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_problems_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_problems_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_problems_diagnosis_fkey" FOREIGN KEY ("organization_id", "source_diagnosis_id") REFERENCES "emr_diagnoses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_problems_code_system_check" CHECK ("code_system" IN ('ICD10', 'ICD11')),
  CONSTRAINT "emr_problems_clinical_status_check" CHECK ("clinical_status" IN ('ACTIVE', 'RECURRENCE', 'RELAPSE', 'INACTIVE', 'REMISSION', 'RESOLVED')),
  CONSTRAINT "emr_problems_verification_check" CHECK ("verification_status" IN ('UNCONFIRMED', 'PROVISIONAL', 'DIFFERENTIAL', 'CONFIRMED', 'REFUTED')),
  CONSTRAINT "emr_problems_dates_check" CHECK ("abatement_date" IS NULL OR "onset_date" IS NULL OR "abatement_date" >= "onset_date")
);
CREATE UNIQUE INDEX "emr_problems_code_key" ON "emr_problems"("organization_id", "patient_id", "code_system", "code");
CREATE INDEX "emr_problems_organization_id_patient_id_created_at_idx" ON "emr_problems"("organization_id", "patient_id", "created_at");

ALTER TABLE "emr_problems" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_problems" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_problems_tenant" ON "emr_problems"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

-- No DELETE; only the status, dates, note and who-changed-it columns can be updated.
GRANT SELECT, INSERT ON "emr_problems" TO sabi_emr_app;
GRANT UPDATE ("clinical_status", "verification_status", "abatement_date", "note", "updated_by_user_id", "version", "updated_at") ON "emr_problems" TO sabi_emr_app;
