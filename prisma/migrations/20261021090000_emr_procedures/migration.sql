-- Minor / outpatient procedures: request → schedule → consent → safety checklist → pre-procedure →
-- performed (operative note) → recovery → follow-up, signed by the performer, corrected by
-- amendments. Never deleted.

-- Performed procedures are billed per procedure (source PROCEDURE, category PROCEDURE).
ALTER TABLE "emr_charges" DROP CONSTRAINT "emr_charges_source_check";
ALTER TABLE "emr_charges" ADD CONSTRAINT "emr_charges_source_check"
  CHECK ("source_type" IN ('ENCOUNTER', 'LAB_ORDER_ITEM', 'LAB_CANCELLED', 'IMAGING_STUDY', 'PROCEDURE', 'DISPENSE_LINE', 'DISPENSE_RETURN', 'BED_DAY', 'MANUAL')) NOT VALID;
ALTER TABLE "emr_charges" VALIDATE CONSTRAINT "emr_charges_source_check";

CREATE TABLE "emr_procedures" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "encounter_id" TEXT,
  "name" VARCHAR(120) NOT NULL,
  "code" VARCHAR(32) NOT NULL,
  "indication" VARCHAR(1000) NOT NULL,
  "body_site" VARCHAR(120),
  "laterality" VARCHAR(10),
  "priority" VARCHAR(10) NOT NULL DEFAULT 'ROUTINE',
  "status" VARCHAR(14) NOT NULL DEFAULT 'REQUESTED',
  "requested_by_user_id" TEXT NOT NULL,
  "scheduled_for" DATE,
  "scheduled_by_user_id" TEXT,
  "performer_user_id" TEXT,
  "assistant_user_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "consent_obtained_by_user_id" TEXT,
  "consent_at" TIMESTAMP(3),
  "pre_procedure_at" TIMESTAMP(3),
  "performed_at" TIMESTAMP(3),
  "performed_by_user_id" TEXT,
  "anaesthesia" VARCHAR(120),
  "device" VARCHAR(120),
  "complications" VARCHAR(1000),
  "outcome" VARCHAR(2000),
  "findings" VARCHAR(2000),
  "specimen_sent_to_lab" BOOLEAN NOT NULL DEFAULT false,
  "recovery_notes" VARCHAR(2000),
  "recovery_at" TIMESTAMP(3),
  "follow_up_plan" VARCHAR(2000),
  "follow_up_at" TIMESTAMP(3),
  "note_signed_by_user_id" TEXT,
  "note_signed_at" TIMESTAMP(3),
  "cancelled_at" TIMESTAMP(3),
  "cancelled_by_user_id" TEXT,
  "cancellation_reason" VARCHAR(300),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_procedures_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_procedures_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_procedures_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_procedures_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_procedures_laterality_check" CHECK ("laterality" IS NULL OR "laterality" IN ('LEFT', 'RIGHT', 'BILATERAL')),
  CONSTRAINT "emr_procedures_priority_check" CHECK ("priority" IN ('ROUTINE', 'URGENT', 'EMERGENCY')),
  CONSTRAINT "emr_procedures_status_check" CHECK ("status" IN ('REQUESTED', 'SCHEDULED', 'CONSENTED', 'PRE_PROCEDURE', 'PERFORMED', 'RECOVERY', 'FOLLOW_UP', 'CANCELLED')),
  -- Each step carries who and when.
  CONSTRAINT "emr_procedures_steps_check" CHECK (
    ("status" IN ('REQUESTED', 'CANCELLED') OR ("scheduled_for" IS NOT NULL AND "performer_user_id" IS NOT NULL AND "scheduled_by_user_id" IS NOT NULL)) AND
    ("status" NOT IN ('CONSENTED', 'PRE_PROCEDURE', 'PERFORMED', 'RECOVERY', 'FOLLOW_UP') OR ("consent_obtained_by_user_id" IS NOT NULL AND "consent_at" IS NOT NULL)) AND
    ("status" NOT IN ('PERFORMED', 'RECOVERY', 'FOLLOW_UP') OR ("performed_at" IS NOT NULL AND "performed_by_user_id" IS NOT NULL AND "outcome" IS NOT NULL)) AND
    ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)) AND
    (("note_signed_by_user_id" IS NULL) = ("note_signed_at" IS NULL))
  )
);
CREATE INDEX "emr_procedures_organization_id_created_at_id_idx" ON "emr_procedures"("organization_id", "created_at", "id");
CREATE INDEX "emr_procedures_organization_id_patient_id_created_at_idx" ON "emr_procedures"("organization_id", "patient_id", "created_at");
CREATE INDEX "emr_procedures_encounter_idx" ON "emr_procedures"("organization_id", "encounter_id") WHERE "encounter_id" IS NOT NULL;

CREATE TABLE "emr_procedure_checklist_items" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "procedure_id" TEXT NOT NULL,
  "phase" VARCHAR(10) NOT NULL,
  "position" INTEGER NOT NULL,
  "label" VARCHAR(200) NOT NULL,
  "completed" BOOLEAN NOT NULL DEFAULT false,
  "exception_reason" VARCHAR(200),
  "updated_by_user_id" TEXT,
  "updated_at" TIMESTAMP(3),
  CONSTRAINT "emr_procedure_checklist_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_procedure_checklist_items_position_key" UNIQUE ("organization_id", "procedure_id", "position"),
  CONSTRAINT "emr_procedure_checklist_items_procedure_fkey" FOREIGN KEY ("organization_id", "procedure_id") REFERENCES "emr_procedures"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_procedure_checklist_items_phase_check" CHECK ("phase" IN ('SIGN_IN', 'TIME_OUT', 'SIGN_OUT')),
  CONSTRAINT "emr_procedure_checklist_items_state_check" CHECK (NOT ("completed" AND "exception_reason" IS NOT NULL))
);

CREATE TABLE "emr_procedure_amendments" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "procedure_id" TEXT NOT NULL,
  "note" VARCHAR(2000) NOT NULL,
  "author_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_procedure_amendments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_procedure_amendments_procedure_fkey" FOREIGN KEY ("organization_id", "procedure_id") REFERENCES "emr_procedures"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "emr_procedure_amendments_organization_id_procedure_id_created_at_idx" ON "emr_procedure_amendments"("organization_id", "procedure_id", "created_at");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_procedures', 'emr_procedure_checklist_items', 'emr_procedure_amendments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

-- No DELETE anywhere. What was requested (patient, name, indication, site, priority) never
-- changes; amendments are append-only.
GRANT SELECT, INSERT ON "emr_procedures" TO sabi_emr_app;
GRANT UPDATE ("status", "scheduled_for", "scheduled_by_user_id", "performer_user_id", "assistant_user_ids", "consent_obtained_by_user_id",
  "consent_at", "pre_procedure_at", "performed_at", "performed_by_user_id", "anaesthesia", "device", "complications", "outcome", "findings",
  "specimen_sent_to_lab", "recovery_notes", "recovery_at", "follow_up_plan", "follow_up_at", "note_signed_by_user_id", "note_signed_at",
  "cancelled_at", "cancelled_by_user_id", "cancellation_reason", "version", "updated_at") ON "emr_procedures" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_procedure_checklist_items" TO sabi_emr_app;
GRANT UPDATE ("completed", "exception_reason", "updated_by_user_id", "updated_at") ON "emr_procedure_checklist_items" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_procedure_amendments" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('procedure.read', 'View procedures and their notes'),
  ('procedure.order.create', 'Request procedures'),
  ('procedure.perform', 'Schedule, consent, check, perform and record procedures')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'procedure.read'),
  ('DOCTOR', 'procedure.order.create'),
  ('DOCTOR', 'procedure.perform'),
  ('NURSE', 'procedure.read'),
  ('NURSE', 'procedure.order.create'),
  ('NURSE', 'procedure.perform'),
  ('HOSPITAL_ADMIN', 'procedure.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
