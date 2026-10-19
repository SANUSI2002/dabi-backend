-- Public-health programmes: the NCD (chronic care) register, and the programme read permission used
-- by the NCD register and the malaria indicators (which are worked out from visits, diagnoses, lab
-- tests and prescriptions already in the record — no copies). One active NCD enrolment per person and
-- condition; the control assessment is the clinician's own judgement, as the screen says.

CREATE TABLE "emr_ncd_clients" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "condition" VARCHAR(40) NOT NULL,
  "systolic" INTEGER,
  "diastolic" INTEGER,
  "fasting_glucose_mmol" DECIMAL(4, 1),
  "control" VARCHAR(12) NOT NULL,
  "next_visit_date" DATE NOT NULL,
  "status" VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
  "enrolled_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_ncd_clients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_ncd_clients_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_ncd_clients_values_check" CHECK (
    "condition" IN ('Essential hypertension', 'Type 2 Diabetes Mellitus', 'Hypertension + Diabetes', 'Asthma', 'Sickle Cell Disease') AND
    "control" IN ('CONTROLLED', 'UNCONTROLLED') AND "status" IN ('ACTIVE') AND
    (("systolic" IS NULL) = ("diastolic" IS NULL)) AND ("systolic" IS NULL OR ("systolic" BETWEEN 50 AND 260 AND "diastolic" BETWEEN 30 AND 180 AND "diastolic" < "systolic")) AND
    ("fasting_glucose_mmol" IS NULL OR "fasting_glucose_mmol" BETWEEN 1 AND 40)
  )
);
CREATE UNIQUE INDEX "emr_ncd_clients_one_active_key" ON "emr_ncd_clients"("organization_id", "patient_id", "condition") WHERE "status" = 'ACTIVE';
CREATE INDEX "emr_ncd_clients_organization_id_next_visit_idx" ON "emr_ncd_clients"("organization_id", "next_visit_date");

ALTER TABLE "emr_ncd_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_ncd_clients" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_ncd_clients_tenant" ON "emr_ncd_clients" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_ncd_clients" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('programme.read', 'View programme registers and indicators (NCD, malaria)'),
  ('ncd.enrol', 'Enrol clients in the NCD register')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'programme.read'), ('DOCTOR', 'ncd.enrol'),
  ('NURSE', 'programme.read'), ('NURSE', 'ncd.enrol'),
  ('HOSPITAL_ADMIN', 'programme.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
