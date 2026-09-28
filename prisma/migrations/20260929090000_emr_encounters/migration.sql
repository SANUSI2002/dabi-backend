-- EMR encounters: visits, clinical notes (signing locks a note; corrections are append-only
-- amendments), vital signs as observations, and diagnoses. Same tenancy rules as
-- 20260928100000_emr_foundation: organization_id on every row, composite foreign keys, RLS.
-- All objects are new, so nothing here locks an existing table beyond an instant catalog change.

CREATE TYPE "EmrEncounterClass" AS ENUM ('OUTPATIENT', 'INPATIENT', 'EMERGENCY', 'TELEHEALTH');
CREATE TYPE "EmrEncounterStatus" AS ENUM ('ARRIVED', 'IN_PROGRESS', 'FINISHED', 'CANCELLED');
CREATE TYPE "EmrEncounterSource" AS ENUM ('DIRECT', 'TELEMEDICINE');
CREATE TYPE "EmrNoteKind" AS ENUM ('CONSULTATION', 'PROGRESS', 'NURSING', 'PROCEDURE', 'DISCHARGE');
CREATE TYPE "EmrNoteStatus" AS ENUM ('DRAFT', 'SIGNED');
CREATE TYPE "EmrEntryStatus" AS ENUM ('ACTIVE', 'ENTERED_IN_ERROR');
CREATE TYPE "EmrDiagnosisRank" AS ENUM ('PRIMARY', 'SECONDARY');

-- Generic guard for append-only tables.
CREATE OR REPLACE FUNCTION emr_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Encounters
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_encounters" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "class" "EmrEncounterClass" NOT NULL DEFAULT 'OUTPATIENT',
  "status" "EmrEncounterStatus" NOT NULL DEFAULT 'ARRIVED',
  "reason" TEXT,
  "attending_user_id" TEXT,
  "source" "EmrEncounterSource" NOT NULL DEFAULT 'DIRECT',
  "source_reference" TEXT,
  "arrived_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "ended_at" TIMESTAMP(3),
  "cancellation_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_user_id" TEXT NOT NULL,
  "updated_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_encounters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_encounters_organization_id_id_key" UNIQUE ("organization_id", "id"),
  -- Lets children reference (encounter, patient) together, so they can never disagree.
  CONSTRAINT "emr_encounters_organization_id_id_patient_id_key" UNIQUE ("organization_id", "id", "patient_id"),
  CONSTRAINT "emr_encounters_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Composite: an encounter can only point at a patient of the SAME tenant (UC-1f).
  CONSTRAINT "emr_encounters_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_encounters_attending_fkey" FOREIGN KEY ("attending_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "emr_encounters_timeline_check" CHECK ("ended_at" IS NULL OR "ended_at" >= "arrived_at"),
  CONSTRAINT "emr_encounters_cancel_check" CHECK ("status" <> 'CANCELLED' OR "cancellation_reason" IS NOT NULL)
);
CREATE INDEX "emr_encounters_organization_id_status_idx" ON "emr_encounters"("organization_id", "status", "arrived_at");
CREATE INDEX "emr_encounters_organization_id_patient_idx" ON "emr_encounters"("organization_id", "patient_id", "arrived_at" DESC);
CREATE INDEX "emr_encounters_organization_id_created_at_idx" ON "emr_encounters"("organization_id", "created_at" DESC, "id" DESC);
-- One open visit per patient per organization: a double check-in (or a race) gets a 409.
CREATE UNIQUE INDEX "emr_encounters_one_open_per_patient_key" ON "emr_encounters"("organization_id", "patient_id")
  WHERE "status" IN ('ARRIVED', 'IN_PROGRESS');
-- A telemedicine appointment becomes at most one encounter per organization (UC-2 replay safety).
CREATE UNIQUE INDEX "emr_encounters_source_reference_key" ON "emr_encounters"("organization_id", "source", "source_reference")
  WHERE "source_reference" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Clinical notes: DRAFT (author may edit) → SIGNED (locked forever). Corrections = amendments.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_clinical_notes" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "encounter_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "kind" "EmrNoteKind" NOT NULL,
  "status" "EmrNoteStatus" NOT NULL DEFAULT 'DRAFT',
  "subjective" TEXT,
  "objective" TEXT,
  "assessment" TEXT,
  "plan" TEXT,
  "body" TEXT,
  "author_user_id" TEXT NOT NULL,
  "signed_by_user_id" TEXT,
  "signed_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_clinical_notes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_clinical_notes_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_clinical_notes_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_clinical_notes_signed_check" CHECK ("status" = 'DRAFT' OR ("signed_by_user_id" IS NOT NULL AND "signed_at" IS NOT NULL))
);
CREATE INDEX "emr_clinical_notes_organization_id_encounter_idx" ON "emr_clinical_notes"("organization_id", "encounter_id", "created_at");
CREATE INDEX "emr_clinical_notes_organization_id_patient_idx" ON "emr_clinical_notes"("organization_id", "patient_id", "created_at" DESC);

CREATE OR REPLACE FUNCTION emr_clinical_notes_lock_signed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'emr_clinical_notes cannot be deleted';
  END IF;
  IF OLD."status" = 'SIGNED' THEN
    RAISE EXCEPTION 'A signed clinical note cannot be changed; add an amendment';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "emr_clinical_notes_lock" BEFORE UPDATE OR DELETE ON "emr_clinical_notes"
  FOR EACH ROW EXECUTE FUNCTION emr_clinical_notes_lock_signed();

CREATE TABLE "emr_note_amendments" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "note_id" TEXT NOT NULL,
  "author_user_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_note_amendments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_note_amendments_note_fkey" FOREIGN KEY ("organization_id", "note_id") REFERENCES "emr_clinical_notes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "emr_note_amendments_organization_id_note_idx" ON "emr_note_amendments"("organization_id", "note_id", "created_at");
CREATE TRIGGER "emr_note_amendments_append_only" BEFORE UPDATE OR DELETE ON "emr_note_amendments"
  FOR EACH ROW EXECUTE FUNCTION emr_append_only();

-- ---------------------------------------------------------------------------------------------
-- Observations (vital signs). Values are never edited: a wrong reading is marked
-- ENTERED_IN_ERROR (column-level grant below) and a new reading is recorded.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_observations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "encounter_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "value" NUMERIC(8, 2) NOT NULL,
  "unit" TEXT NOT NULL,
  "status" "EmrEntryStatus" NOT NULL DEFAULT 'ACTIVE',
  "recorded_by_user_id" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "error_reason" TEXT,
  "errored_by_user_id" TEXT,
  "errored_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_observations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_observations_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_observations_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_observations_code_check" CHECK ("code" IN ('BP_SYSTOLIC', 'BP_DIASTOLIC', 'HEART_RATE', 'RESPIRATORY_RATE', 'TEMPERATURE', 'SPO2', 'WEIGHT', 'HEIGHT', 'BLOOD_GLUCOSE', 'PAIN_SCORE')),
  CONSTRAINT "emr_observations_error_check" CHECK ("status" = 'ACTIVE' OR "error_reason" IS NOT NULL)
);
CREATE INDEX "emr_observations_organization_id_encounter_idx" ON "emr_observations"("organization_id", "encounter_id", "recorded_at");
CREATE INDEX "emr_observations_organization_id_patient_code_idx" ON "emr_observations"("organization_id", "patient_id", "code", "recorded_at" DESC);

-- ---------------------------------------------------------------------------------------------
-- Diagnoses (ICD-10 coded). One active PRIMARY diagnosis per encounter.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_diagnoses" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "encounter_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "rank" "EmrDiagnosisRank" NOT NULL DEFAULT 'SECONDARY',
  "status" "EmrEntryStatus" NOT NULL DEFAULT 'ACTIVE',
  "recorded_by_user_id" TEXT NOT NULL,
  "error_reason" TEXT,
  "errored_by_user_id" TEXT,
  "errored_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_diagnoses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_diagnoses_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_diagnoses_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_diagnoses_error_check" CHECK ("status" = 'ACTIVE' OR "error_reason" IS NOT NULL)
);
CREATE INDEX "emr_diagnoses_organization_id_encounter_idx" ON "emr_diagnoses"("organization_id", "encounter_id", "created_at");
CREATE INDEX "emr_diagnoses_organization_id_patient_idx" ON "emr_diagnoses"("organization_id", "patient_id", "created_at" DESC);
CREATE UNIQUE INDEX "emr_diagnoses_one_primary_key" ON "emr_diagnoses"("organization_id", "encounter_id")
  WHERE "rank" = 'PRIMARY' AND "status" = 'ACTIVE';

-- ---------------------------------------------------------------------------------------------
-- Row-level security: tenant-only, no worker/system clause (clinical data).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "emr_encounters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_encounters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_encounters_tenant" ON "emr_encounters"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_clinical_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_clinical_notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_clinical_notes_tenant" ON "emr_clinical_notes"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_note_amendments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_note_amendments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_note_amendments_tenant" ON "emr_note_amendments"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_observations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_observations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_observations_tenant" ON "emr_observations"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_diagnoses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_diagnoses" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_diagnoses_tenant" ON "emr_diagnoses"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

-- Least privilege for the request role: no DELETE anywhere; observations and diagnoses can only
-- have their error-marking columns changed.
GRANT SELECT, INSERT, UPDATE ON "emr_encounters" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_clinical_notes" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_note_amendments" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_observations" TO sabi_emr_app;
GRANT UPDATE ("status", "error_reason", "errored_by_user_id", "errored_at") ON "emr_observations" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_diagnoses" TO sabi_emr_app;
GRANT UPDATE ("status", "error_reason", "errored_by_user_id", "errored_at") ON "emr_diagnoses" TO sabi_emr_app;

-- ---------------------------------------------------------------------------------------------
-- Permissions. Reception checks patients in and sees the visit list, but not clinical content.
-- Nurses record vitals and sign nursing notes; only doctors sign other notes and diagnose.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('encounter.read', 'View the organization''s visits (list and status, no clinical content)'),
  ('encounter.create', 'Check a patient in (open a visit)'),
  ('encounter.update', 'Start, finish, cancel or reassign a visit'),
  ('clinical.read', 'Read clinical notes, vital signs and diagnoses'),
  ('clinical.note.write', 'Write draft clinical notes'),
  ('clinical.note.sign', 'Sign and amend any clinical note'),
  ('nursing.note.sign', 'Sign and amend nursing notes'),
  ('vitals.record', 'Record vital signs'),
  ('diagnosis.record', 'Record diagnoses')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'encounter.read'),
  ('DOCTOR', 'encounter.create'),
  ('DOCTOR', 'encounter.update'),
  ('DOCTOR', 'clinical.read'),
  ('DOCTOR', 'clinical.note.write'),
  ('DOCTOR', 'clinical.note.sign'),
  ('DOCTOR', 'vitals.record'),
  ('DOCTOR', 'diagnosis.record'),
  ('NURSE', 'encounter.read'),
  ('NURSE', 'encounter.create'),
  ('NURSE', 'encounter.update'),
  ('NURSE', 'clinical.read'),
  ('NURSE', 'clinical.note.write'),
  ('NURSE', 'nursing.note.sign'),
  ('NURSE', 'vitals.record'),
  ('RECEPTIONIST', 'encounter.read'),
  ('RECEPTIONIST', 'encounter.create'),
  ('HOSPITAL_ADMIN', 'encounter.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
