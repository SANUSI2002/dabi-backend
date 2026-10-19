-- Child health (growth monitoring) and nutrition (CMAM). Classification and programme are worked out
-- by the server from MUAC, oedema and the appetite test, never typed: SAM (MUAC < 11.5 cm or any
-- oedema) goes to OTP, or to the Stabilisation Centre (SC) when the appetite test fails or oedema is
-- severe; MAM (MUAC < 12.5 cm) goes to SFP. A malnourished growth visit enrols the child in CMAM in the
-- same transaction unless the child is already in the caseload. One open caseload entry per child.

CREATE TABLE "emr_growth_visits" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "visit_date" DATE NOT NULL,
  "weight_kg" DECIMAL(4, 1) NOT NULL,
  "height_cm" DECIMAL(4, 1) NOT NULL,
  "muac_cm" DECIMAL(3, 1) NOT NULL,
  "waz" DECIMAL(3, 1),
  "feeding" VARCHAR(30) NOT NULL,
  "classification" VARCHAR(8) NOT NULL,
  "recorded_by_user_id" TEXT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "error_reason" VARCHAR(300),
  "errored_by_user_id" TEXT,
  "errored_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_growth_visits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_growth_visits_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_growth_visits_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_growth_visits_values_check" CHECK (
    "weight_kg" BETWEEN 0.5 AND 40 AND "height_cm" BETWEEN 30 AND 130 AND "muac_cm" BETWEEN 5 AND 25 AND ("waz" IS NULL OR "waz" BETWEEN -6 AND 6) AND
    "feeding" IN ('EXCLUSIVE_BREASTFEEDING', 'COMPLEMENTARY_AND_BREAST', 'FAMILY_DIET', 'FORMULA') AND "classification" IN ('NORMAL', 'MAM', 'SAM')
  ),
  CONSTRAINT "emr_growth_visits_status_check" CHECK ("status" IN ('ACTIVE', 'ENTERED_IN_ERROR')),
  CONSTRAINT "emr_growth_visits_error_check" CHECK (("status" = 'ENTERED_IN_ERROR') = ("error_reason" IS NOT NULL AND "errored_by_user_id" IS NOT NULL AND "errored_at" IS NOT NULL))
);
CREATE INDEX "emr_growth_visits_organization_id_visit_date_idx" ON "emr_growth_visits"("organization_id", "visit_date");

CREATE TABLE "emr_cmam_screenings" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "screening_date" DATE NOT NULL,
  "muac_cm" DECIMAL(3, 1) NOT NULL,
  "oedema" VARCHAR(10) NOT NULL,
  "appetite" VARCHAR(4) NOT NULL,
  "growth_monitoring_done" BOOLEAN,
  "notes" VARCHAR(1000),
  "classification" VARCHAR(8) NOT NULL,
  "programme" VARCHAR(4),
  "source" VARCHAR(14) NOT NULL,
  "growth_visit_id" TEXT,
  "outcome" VARCHAR(14),
  "discharged_at" TIMESTAMP(3),
  "discharged_by_user_id" TEXT,
  "recorded_by_user_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_cmam_screenings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_cmam_screenings_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_cmam_screenings_growth_fkey" FOREIGN KEY ("organization_id", "growth_visit_id") REFERENCES "emr_growth_visits"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_cmam_screenings_values_check" CHECK (
    "muac_cm" BETWEEN 5 AND 25 AND "oedema" IN ('NONE', 'MILD', 'MODERATE', 'SEVERE') AND "appetite" IN ('PASS', 'FAIL') AND
    "classification" IN ('NORMAL', 'MAM', 'SAM') AND "source" IN ('NUTRITION', 'CHILD_HEALTH') AND
    (("classification" = 'NORMAL') = ("programme" IS NULL)) AND ("programme" IS NULL OR "programme" IN ('OTP', 'SC', 'SFP')) AND
    ("outcome" IS NULL OR "outcome" IN ('CURED', 'NON_RESPONSE', 'DEFAULTER', 'DEATH', 'TRANSFERRED'))
  ),
  CONSTRAINT "emr_cmam_screenings_discharge_check" CHECK (
    (("outcome" IS NULL) = ("discharged_at" IS NULL AND "discharged_by_user_id" IS NULL)) AND ("outcome" IS NULL OR "classification" <> 'NORMAL')
  )
);
-- One open CMAM caseload entry per child.
CREATE UNIQUE INDEX "emr_cmam_screenings_one_open_key" ON "emr_cmam_screenings"("organization_id", "patient_id") WHERE "classification" <> 'NORMAL' AND "outcome" IS NULL;
CREATE INDEX "emr_cmam_screenings_organization_id_screening_date_idx" ON "emr_cmam_screenings"("organization_id", "screening_date");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_growth_visits', 'emr_cmam_screenings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON "emr_growth_visits" TO sabi_emr_app;
GRANT UPDATE ("status", "error_reason", "errored_by_user_id", "errored_at") ON "emr_growth_visits" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_cmam_screenings" TO sabi_emr_app;
GRANT UPDATE ("outcome", "discharged_at", "discharged_by_user_id", "version", "updated_at") ON "emr_cmam_screenings" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('nutrition.read', 'View growth monitoring and CMAM records'),
  ('nutrition.record', 'Record growth visits and CMAM screenings, and discharge from CMAM')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'nutrition.read'), ('DOCTOR', 'nutrition.record'),
  ('NURSE', 'nutrition.read'), ('NURSE', 'nutrition.record'),
  ('HOSPITAL_ADMIN', 'nutrition.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
