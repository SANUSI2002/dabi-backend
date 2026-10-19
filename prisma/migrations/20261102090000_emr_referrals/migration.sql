-- Referrals: external (to another organisation), internal (to a unit here) and inbound (received, or a
-- back-referral for continued care). Lifecycle: REQUESTED → ACCEPTED | DECLINED → SCHEDULED → ATTENDED →
-- COMPLETED (the outcome that comes back closes the loop), or CANCELLED before it is attended. Verified
-- lab tests of the same patient can travel with the referral. Corrections are new records, never deletes.

CREATE TABLE "emr_referrals" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "direction" VARCHAR(8) NOT NULL,
  "destination" VARCHAR(200) NOT NULL,
  "diagnosis" VARCHAR(300) NOT NULL,
  "reason" VARCHAR(60) NOT NULL,
  "urgency" VARCHAR(9) NOT NULL,
  "status" VARCHAR(9) NOT NULL DEFAULT 'REQUESTED',
  "clinical_summary" VARCHAR(4000),
  "attached_lab_item_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "referred_by_user_id" TEXT,
  "referred_by_name" VARCHAR(160),
  "source_referral_id" TEXT,
  "receiving_clinician" VARCHAR(160),
  "decline_reason" VARCHAR(500),
  "appointment_date" DATE,
  "attended_at" TIMESTAMP(3),
  "outcome" VARCHAR(30),
  "outcome_note" VARCHAR(2000),
  "outcome_by" VARCHAR(160),
  "outcome_at" TIMESTAMP(3),
  "back_referral" BOOLEAN NOT NULL DEFAULT false,
  "updated_by_user_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_referrals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_referrals_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_referrals_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_referrals_source_fkey" FOREIGN KEY ("organization_id", "source_referral_id") REFERENCES "emr_referrals"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_referrals_values_check" CHECK (
    "direction" IN ('OUT', 'INTERNAL', 'IN') AND "urgency" IN ('ROUTINE', 'URGENT', 'EMERGENCY') AND
    "status" IN ('REQUESTED', 'ACCEPTED', 'DECLINED', 'SCHEDULED', 'ATTENDED', 'COMPLETED', 'CANCELLED') AND
    ("status" <> 'DECLINED' OR "decline_reason" IS NOT NULL) AND
    ("status" <> 'SCHEDULED' OR "appointment_date" IS NOT NULL) AND
    ("status" <> 'COMPLETED' OR "direction" = 'IN' OR ("outcome" IS NOT NULL AND "outcome_by" IS NOT NULL AND "outcome_at" IS NOT NULL)) AND
    ("outcome" IS NULL OR "outcome" IN ('Admitted & managed', 'Treated & discharged', 'Investigations done', 'Patient did not attend', 'Referred onward'))
  )
);
CREATE INDEX "emr_referrals_organization_id_created_at_idx" ON "emr_referrals"("organization_id", "created_at");
CREATE INDEX "emr_referrals_organization_id_patient_id_idx" ON "emr_referrals"("organization_id", "patient_id");

ALTER TABLE "emr_referrals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_referrals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_referrals_tenant" ON "emr_referrals" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_referrals" TO sabi_emr_app;
GRANT UPDATE ("status", "receiving_clinician", "decline_reason", "appointment_date", "attended_at", "outcome", "outcome_note", "outcome_by", "outcome_at", "back_referral", "updated_by_user_id", "version", "updated_at") ON "emr_referrals" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('referral.read', 'View referrals'),
  ('referral.manage', 'Send referrals and track them to their outcome')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'referral.read'), ('DOCTOR', 'referral.manage'),
  ('NURSE', 'referral.read'), ('NURSE', 'referral.manage'),
  ('HOSPITAL_ADMIN', 'referral.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
