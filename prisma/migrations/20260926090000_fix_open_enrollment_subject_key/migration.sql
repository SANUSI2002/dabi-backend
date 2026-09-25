-- One open (PENDING/ACTIVE) enrollment per subject per hospital. The original index keyed on
-- (patient_id, hospital_id) only, so a patient's own enrollment blocked enrolling any of their
-- dependents at the same hospital. The subject is the patient themselves (dependent_id NULL) or a
-- dependent. The new index is strictly less restrictive, so it builds on any existing data.
DROP INDEX IF EXISTS "hospital_enrollments_open_subject_hospital_key";
CREATE UNIQUE INDEX "hospital_enrollments_open_subject_hospital_key"
  ON "hospital_enrollments" ("patient_id", "hospital_id", COALESCE("dependent_id", ''))
  WHERE "status" IN ('PENDING', 'ACTIVE');
