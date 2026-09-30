-- The ward's view of an admission and the nursing flowsheet:
--   admissions: admitting diagnosis, service, isolation precautions, whether the team considers the
--               patient ready for discharge, and where they were discharged to;
--   emr_nursing_assessments: what nurses record beside vital signs at each round — fluid intake and
--               output, mobility, falls and pressure-injury risk, and a note. Rows are never changed
--               (the app role may only read and insert them).

ALTER TABLE "emr_admissions"
  ADD COLUMN "admitting_diagnosis" TEXT,
  ADD COLUMN "service" TEXT,
  ADD COLUMN "isolation" TEXT,
  ADD COLUMN "discharge_ready" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "discharge_destination" TEXT;

CREATE TABLE "emr_nursing_assessments" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "admission_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL,
  "fluid_intake_ml" INTEGER,
  "fluid_output_ml" INTEGER,
  "mobility" TEXT,
  "falls_risk" TEXT,
  "pressure_risk" TEXT,
  "note" TEXT,
  "recorded_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_nursing_assessments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_nursing_assessments_admission_fkey" FOREIGN KEY ("organization_id", "admission_id", "patient_id")
    REFERENCES "emr_admissions"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_nursing_assessments_fluids_check" CHECK (
    ("fluid_intake_ml" IS NULL OR "fluid_intake_ml" BETWEEN 0 AND 20000) AND ("fluid_output_ml" IS NULL OR "fluid_output_ml" BETWEEN 0 AND 20000)),
  CONSTRAINT "emr_nursing_assessments_risk_check" CHECK (
    ("falls_risk" IS NULL OR "falls_risk" IN ('Low', 'Moderate', 'High')) AND ("pressure_risk" IS NULL OR "pressure_risk" IN ('Low', 'Moderate', 'High'))),
  CONSTRAINT "emr_nursing_assessments_content_check" CHECK (
    num_nonnulls("fluid_intake_ml", "fluid_output_ml", "mobility", "falls_risk", "pressure_risk", "note") > 0)
);
CREATE INDEX "emr_nursing_assessments_organization_id_admission_idx" ON "emr_nursing_assessments"("organization_id", "admission_id", "recorded_at");

ALTER TABLE "emr_nursing_assessments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_nursing_assessments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_nursing_assessments_tenant" ON "emr_nursing_assessments"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_nursing_assessments" TO sabi_emr_app;
