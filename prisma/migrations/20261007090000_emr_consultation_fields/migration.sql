-- What the consultation screen records beyond SOAP text:
--   diagnoses: the code system (ICD-10 or ICD-11, the WHO's current revision) and whether the
--              diagnosis belongs on the patient's problem list (chronic/ongoing) or this visit only;
--   notes:     structured physical examination, follow-up and the instructions given to the patient
--              (locked with the note once it is signed, like the rest of it);
--   visits:    the visit type and the NHMIS reporting indicators ticked for the visit.
-- All columns are additive with defaults or nullable; new checks are added NOT VALID then validated.

ALTER TABLE "emr_diagnoses"
  ADD COLUMN "code_system" TEXT NOT NULL DEFAULT 'ICD10',
  ADD COLUMN "on_problem_list" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "emr_diagnoses" ADD CONSTRAINT "emr_diagnoses_code_system_check"
  CHECK ("code_system" IN ('ICD10', 'ICD11')) NOT VALID;
ALTER TABLE "emr_diagnoses" VALIDATE CONSTRAINT "emr_diagnoses_code_system_check";
-- The problem list is read per patient across visits.
CREATE INDEX "emr_diagnoses_problem_list_idx" ON "emr_diagnoses"("organization_id", "patient_id")
  WHERE "on_problem_list" AND "status" = 'ACTIVE';

ALTER TABLE "emr_clinical_notes"
  ADD COLUMN "examination" JSONB,
  ADD COLUMN "follow_up" TEXT,
  ADD COLUMN "patient_instructions" TEXT;
ALTER TABLE "emr_clinical_notes" ADD CONSTRAINT "emr_clinical_notes_examination_check"
  CHECK ("examination" IS NULL OR jsonb_typeof("examination") = 'array') NOT VALID;
ALTER TABLE "emr_clinical_notes" VALIDATE CONSTRAINT "emr_clinical_notes_examination_check";

ALTER TABLE "emr_encounters"
  ADD COLUMN "visit_type" TEXT,
  ADD COLUMN "nhmis_indicators" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
