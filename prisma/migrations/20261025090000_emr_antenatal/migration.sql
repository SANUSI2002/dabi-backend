-- Antenatal care (first part of Maternal & Child Health): a pregnancy is enrolled once, visits are
-- recorded against it, and it is closed when the woman delivers, transfers out or the pregnancy ends.
-- EDD and gestational age come from the LMP (Naegele: LMP + 280 days), never typed in. Visits are
-- never edited or deleted; a wrong one is marked entered-in-error.

CREATE TABLE "emr_pregnancies" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "lmp" DATE NOT NULL,
  "edd" DATE NOT NULL,
  "gravida" INTEGER NOT NULL,
  "parity" INTEGER NOT NULL,
  "blood_group" VARCHAR(3),
  "booking_hb" DECIMAL(4, 1),
  "tt_doses" INTEGER NOT NULL DEFAULT 0,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "enrolled_by_user_id" TEXT NOT NULL,
  "closed_at" TIMESTAMP(3),
  "closed_by_user_id" TEXT,
  "closure_note" VARCHAR(300),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_pregnancies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_pregnancies_organization_id_id_patient_id_key" UNIQUE ("organization_id", "id", "patient_id"),
  CONSTRAINT "emr_pregnancies_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_pregnancies_edd_check" CHECK ("edd" = "lmp" + 280),
  CONSTRAINT "emr_pregnancies_obstetric_check" CHECK ("gravida" BETWEEN 1 AND 20 AND "parity" >= 0 AND "parity" < "gravida" AND "tt_doses" BETWEEN 0 AND 5),
  CONSTRAINT "emr_pregnancies_blood_group_check" CHECK ("blood_group" IS NULL OR "blood_group" IN ('O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-')),
  CONSTRAINT "emr_pregnancies_booking_hb_check" CHECK ("booking_hb" IS NULL OR "booking_hb" BETWEEN 2 AND 25),
  CONSTRAINT "emr_pregnancies_status_check" CHECK ("status" IN ('ACTIVE', 'DELIVERED', 'TRANSFERRED_OUT', 'ENDED')),
  CONSTRAINT "emr_pregnancies_closure_check" CHECK (("status" = 'ACTIVE') = ("closed_at" IS NULL AND "closed_by_user_id" IS NULL))
);
-- One ongoing pregnancy per woman per hospital.
CREATE UNIQUE INDEX "emr_pregnancies_one_active_key" ON "emr_pregnancies"("organization_id", "patient_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "emr_pregnancies_organization_id_created_at_id_idx" ON "emr_pregnancies"("organization_id", "created_at", "id");

CREATE TABLE "emr_anc_visits" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "pregnancy_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "visit_date" DATE NOT NULL,
  "gestational_weeks" INTEGER NOT NULL,
  "weight_kg" DECIMAL(5, 1),
  "systolic" INTEGER,
  "diastolic" INTEGER,
  "hb" DECIMAL(4, 1),
  "fetal_heart_rate" INTEGER,
  "next_visit_date" DATE,
  "notes" VARCHAR(1000),
  "recorded_by_user_id" TEXT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "error_reason" VARCHAR(300),
  "errored_by_user_id" TEXT,
  "errored_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_anc_visits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_anc_visits_pregnancy_fkey" FOREIGN KEY ("organization_id", "pregnancy_id", "patient_id") REFERENCES "emr_pregnancies"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_anc_visits_measures_check" CHECK (
    ("weight_kg" IS NULL OR "weight_kg" BETWEEN 25 AND 250) AND
    (("systolic" IS NULL) = ("diastolic" IS NULL)) AND ("systolic" IS NULL OR ("systolic" BETWEEN 50 AND 260 AND "diastolic" BETWEEN 30 AND 180 AND "diastolic" < "systolic")) AND
    ("hb" IS NULL OR "hb" BETWEEN 2 AND 25) AND ("fetal_heart_rate" IS NULL OR "fetal_heart_rate" BETWEEN 60 AND 240) AND
    "gestational_weeks" BETWEEN 0 AND 45 AND ("next_visit_date" IS NULL OR "next_visit_date" > "visit_date")
  ),
  CONSTRAINT "emr_anc_visits_status_check" CHECK ("status" IN ('ACTIVE', 'ENTERED_IN_ERROR')),
  CONSTRAINT "emr_anc_visits_error_check" CHECK (("status" = 'ENTERED_IN_ERROR') = ("error_reason" IS NOT NULL AND "errored_by_user_id" IS NOT NULL AND "errored_at" IS NOT NULL))
);
CREATE INDEX "emr_anc_visits_pregnancy_idx" ON "emr_anc_visits"("organization_id", "pregnancy_id", "visit_date");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_pregnancies', 'emr_anc_visits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

-- No DELETE. The enrolment facts (patient, LMP, EDD, gravida, parity) never change; a pregnancy only
-- closes. Visits change only by being marked entered-in-error.
GRANT SELECT, INSERT ON "emr_pregnancies" TO sabi_emr_app;
GRANT UPDATE ("status", "closed_at", "closed_by_user_id", "closure_note", "version", "updated_at") ON "emr_pregnancies" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_anc_visits" TO sabi_emr_app;
GRANT UPDATE ("status", "error_reason", "errored_by_user_id", "errored_at") ON "emr_anc_visits" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('anc.read', 'View antenatal enrolments and visits'),
  ('anc.manage', 'Enrol pregnancies, record antenatal visits and close pregnancies')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'anc.read'),
  ('DOCTOR', 'anc.manage'),
  ('NURSE', 'anc.read'),
  ('NURSE', 'anc.manage'),
  ('HOSPITAL_ADMIN', 'anc.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
