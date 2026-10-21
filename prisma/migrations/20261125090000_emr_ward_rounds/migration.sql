-- Ward rounds for admitted patients. A round is a structured clinical note on the admission's visit:
-- participants, progress, devices, problems with their plans, a safety checklist, discharge readiness,
-- what was discussed with the patient, plan tasks and an optional physical examination. It is a draft
-- until a clinician signs it; once signed its content is frozen (the database refuses changes) and it
-- can only be amended, by appending an amendment note.
--
-- Medication decisions taken on a round are recorded in emr_medication_changes (append-only) and act on
-- the real prescriptions: a medicine is stopped (its line closed), held (charting a dose is refused until
-- it is restarted), or changed (the old line closed as replaced and a new prescription raised, which goes
-- to the pharmacy for review like any other).

CREATE TABLE "emr_ward_rounds" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "admission_id" TEXT NOT NULL, "patient_id" TEXT NOT NULL, "encounter_id" TEXT NOT NULL,
  "clinician_user_id" TEXT NOT NULL, "department" VARCHAR(120), "round_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "participants" JSONB NOT NULL DEFAULT '[]', "clinical_progress" VARCHAR(20), "progress_note" TEXT NOT NULL DEFAULT '',
  "devices" JSONB NOT NULL DEFAULT '[]', "problems" JSONB NOT NULL DEFAULT '[]', "tasks" JSONB NOT NULL DEFAULT '[]',
  "safety_checklist" JSONB NOT NULL DEFAULT '{}', "escalation_plan" VARCHAR(2000), "discharge_readiness" JSONB NOT NULL DEFAULT '{}', "communication" JSONB NOT NULL DEFAULT '{}',
  "examination" JSONB, "examination_recorded_by_user_id" TEXT, "examination_recorded_at" TIMESTAMP(3),
  "summary" TEXT NOT NULL DEFAULT '', "status" VARCHAR(8) NOT NULL DEFAULT 'draft', "signed_by_user_id" TEXT, "signed_at" TIMESTAMP(3),
  "updated_by_user_id" TEXT, "updated_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "emr_ward_rounds_pkey" PRIMARY KEY ("id"), CONSTRAINT "emr_ward_rounds_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_ward_rounds_admission_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "emr_admissions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_ward_rounds_check" CHECK (
    "status" IN ('draft', 'signed', 'amended') AND ("status" = 'draft' OR ("signed_by_user_id" IS NOT NULL AND "signed_at" IS NOT NULL)) AND
    jsonb_typeof("participants") = 'array' AND jsonb_typeof("devices") = 'array' AND jsonb_typeof("problems") = 'array' AND jsonb_typeof("tasks") = 'array'
  )
);
CREATE INDEX "emr_ward_rounds_admission_idx" ON "emr_ward_rounds"("organization_id", "admission_id", "round_at");
-- one draft round per admission at a time
CREATE UNIQUE INDEX "emr_ward_rounds_draft_key" ON "emr_ward_rounds"("organization_id", "admission_id") WHERE "status" = 'draft';

-- A signed round's content never changes; only its status may move on to 'amended'.
CREATE FUNCTION emr_ward_round_frozen() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" <> 'draft' AND (
    NEW."participants" IS DISTINCT FROM OLD."participants" OR NEW."clinical_progress" IS DISTINCT FROM OLD."clinical_progress" OR NEW."progress_note" IS DISTINCT FROM OLD."progress_note" OR
    NEW."devices" IS DISTINCT FROM OLD."devices" OR NEW."problems" IS DISTINCT FROM OLD."problems" OR NEW."tasks" IS DISTINCT FROM OLD."tasks" OR
    NEW."safety_checklist" IS DISTINCT FROM OLD."safety_checklist" OR NEW."escalation_plan" IS DISTINCT FROM OLD."escalation_plan" OR
    NEW."discharge_readiness" IS DISTINCT FROM OLD."discharge_readiness" OR NEW."communication" IS DISTINCT FROM OLD."communication" OR
    NEW."examination" IS DISTINCT FROM OLD."examination" OR NEW."summary" IS DISTINCT FROM OLD."summary" OR
    NEW."signed_by_user_id" IS DISTINCT FROM OLD."signed_by_user_id" OR NEW."signed_at" IS DISTINCT FROM OLD."signed_at" OR NEW."status" = 'draft'
  ) THEN
    RAISE EXCEPTION 'A signed ward round cannot be changed; add an amendment instead' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "emr_ward_rounds_frozen" BEFORE UPDATE ON "emr_ward_rounds" FOR EACH ROW EXECUTE FUNCTION emr_ward_round_frozen();

CREATE TABLE "emr_ward_round_amendments" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "ward_round_id" TEXT NOT NULL, "note" VARCHAR(4000) NOT NULL, "by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_ward_round_amendments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_ward_round_amendments_round_fkey" FOREIGN KEY ("organization_id", "ward_round_id") REFERENCES "emr_ward_rounds"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "emr_medication_changes" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "patient_id" TEXT NOT NULL, "encounter_id" TEXT NOT NULL, "ward_round_id" TEXT,
  "prescription_item_id" TEXT, "replacement_prescription_id" TEXT, "drug_name" VARCHAR(200) NOT NULL, "action" VARCHAR(18) NOT NULL,
  "previous_dose" VARCHAR(60), "previous_frequency" VARCHAR(60), "previous_route" VARCHAR(60), "new_dose" VARCHAR(60), "new_frequency" VARCHAR(60), "new_route" VARCHAR(60),
  "reason" VARCHAR(1000) NOT NULL, "clinical_note" VARCHAR(2000), "monitoring_required" VARCHAR(1000), "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "clinician_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_medication_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_medication_changes_round_fkey" FOREIGN KEY ("organization_id", "ward_round_id") REFERENCES "emr_ward_rounds"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_medication_changes_check" CHECK ("action" IN ('STARTED', 'STOPPED', 'HELD', 'RESTARTED', 'DOSE_INCREASED', 'DOSE_DECREASED', 'FREQUENCY_CHANGED', 'ROUTE_CHANGED', 'REPLACED'))
);
CREATE INDEX "emr_medication_changes_patient_idx" ON "emr_medication_changes"("organization_id", "patient_id", "created_at");

-- A medicine put on hold on a round: charted doses are refused until it is restarted.
ALTER TABLE "emr_prescription_items" ADD COLUMN "held_at" TIMESTAMP(3), ADD COLUMN "held_reason" VARCHAR(1000), ADD COLUMN "held_by_user_id" TEXT;
-- A round closes a line as STOPPED, or as REPLACED by the new prescription it raised.
ALTER TABLE "emr_prescription_items" DROP CONSTRAINT "emr_prescription_items_close_check";
ALTER TABLE "emr_prescription_items" ADD CONSTRAINT "emr_prescription_items_close_check"
  CHECK (
    ("close_outcome" IS NULL AND "close_reason" IS NULL AND "closed_by_user_id" IS NULL AND "closed_at" IS NULL)
    OR ("close_outcome" IN ('OUTSOURCED', 'NOT_DISPENSED', 'STOPPED', 'REPLACED') AND "close_reason" IS NOT NULL
        AND "closed_by_user_id" IS NOT NULL AND "closed_at" IS NOT NULL AND "status" = 'CANCELLED')
  );
GRANT UPDATE ("held_at", "held_reason", "held_by_user_id") ON "emr_prescription_items" TO sabi_emr_app;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_ward_rounds', 'emr_ward_round_amendments', 'emr_medication_changes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("participants", "clinical_progress", "progress_note", "devices", "problems", "tasks", "safety_checklist", "escalation_plan", "discharge_readiness",
  "communication", "examination", "examination_recorded_by_user_id", "examination_recorded_at", "summary", "status", "signed_by_user_id", "signed_at",
  "updated_by_user_id", "updated_at", "version") ON "emr_ward_rounds" TO sabi_emr_app;
