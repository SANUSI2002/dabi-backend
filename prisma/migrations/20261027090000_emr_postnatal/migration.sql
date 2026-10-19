-- Postnatal care (Maternal & Child Health, part 3): WHO four-contact schedule after a delivery.
-- A visit is linked to the mother's delivery when there is one here (days postpartum then come from
-- the delivery time); the contact number (1–4) is worked out from days postpartum. Newborn danger
-- signs open an urgent Consultation visit for the mother unless she already has an open visit.
-- Visits are never edited or deleted; a wrong one is marked entered-in-error.

CREATE TABLE "emr_pnc_visits" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "delivery_id" TEXT,
  "visit_date" DATE NOT NULL,
  "days_postpartum" INTEGER NOT NULL,
  "contact" INTEGER NOT NULL,
  "systolic" INTEGER,
  "diastolic" INTEGER,
  "uterus" VARCHAR(20) NOT NULL,
  "lochia" VARCHAR(12) NOT NULL,
  "breast" VARCHAR(16) NOT NULL,
  "breastfeeding" VARCHAR(20) NOT NULL,
  "danger_signs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "fp_counselled" BOOLEAN NOT NULL DEFAULT false,
  "notes" VARCHAR(1000),
  "escalated_encounter_id" TEXT,
  "recorded_by_user_id" TEXT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "error_reason" VARCHAR(300),
  "errored_by_user_id" TEXT,
  "errored_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_pnc_visits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_pnc_visits_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_pnc_visits_delivery_fkey" FOREIGN KEY ("organization_id", "delivery_id") REFERENCES "emr_deliveries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_pnc_visits_encounter_fkey" FOREIGN KEY ("organization_id", "escalated_encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_pnc_visits_values_check" CHECK (
    "days_postpartum" BETWEEN 0 AND 60 AND "contact" BETWEEN 1 AND 4 AND
    (("systolic" IS NULL) = ("diastolic" IS NULL)) AND ("systolic" IS NULL OR ("systolic" BETWEEN 50 AND 260 AND "diastolic" BETWEEN 30 AND 180 AND "diastolic" < "systolic")) AND
    "uterus" IN ('WELL_CONTRACTED', 'POORLY_CONTRACTED', 'TENDER') AND
    "lochia" IN ('NORMAL', 'EXCESSIVE', 'OFFENSIVE') AND
    "breast" IN ('NORMAL', 'ENGORGED', 'CRACKED_NIPPLE', 'MASTITIS') AND
    "breastfeeding" IN ('EXCLUSIVE', 'MIXED', 'NOT_BREASTFEEDING')
  ),
  CONSTRAINT "emr_pnc_visits_status_check" CHECK ("status" IN ('ACTIVE', 'ENTERED_IN_ERROR')),
  CONSTRAINT "emr_pnc_visits_error_check" CHECK (("status" = 'ENTERED_IN_ERROR') = ("error_reason" IS NOT NULL AND "errored_by_user_id" IS NOT NULL AND "errored_at" IS NOT NULL))
);
CREATE INDEX "emr_pnc_visits_organization_id_visit_date_id_idx" ON "emr_pnc_visits"("organization_id", "visit_date", "id");
CREATE INDEX "emr_pnc_visits_patient_idx" ON "emr_pnc_visits"("organization_id", "patient_id", "visit_date");

ALTER TABLE "emr_pnc_visits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_pnc_visits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_pnc_visits_tenant" ON "emr_pnc_visits" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

GRANT SELECT, INSERT ON "emr_pnc_visits" TO sabi_emr_app;
GRANT UPDATE ("status", "error_reason", "errored_by_user_id", "errored_at") ON "emr_pnc_visits" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('pnc.read', 'View postnatal visits and contacts due'),
  ('pnc.record', 'Record postnatal visits')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'pnc.read'), ('DOCTOR', 'pnc.record'),
  ('NURSE', 'pnc.read'), ('NURSE', 'pnc.record'),
  ('HOSPITAL_ADMIN', 'pnc.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
