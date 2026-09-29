-- Patient intake fields used by the EMR registration screen, and the station queue (patient flow
-- through Vitals → Consultation → Lab → Pharmacy → Exit, with priority and call-next).
--
-- The queue lives in its own table (one entry per visit, own version) rather than on the visit, so
-- the constant movement of patients between stations never conflicts with clinicians editing the
-- visit itself. emr_patients changes are additive nullable columns (instant); new constraints are
-- added NOT VALID and validated separately so writes are not blocked while existing rows are checked.

ALTER TABLE "emr_patients"
  ADD COLUMN "preferred_name" TEXT,
  ADD COLUMN "payer" TEXT,
  ADD COLUMN "category" TEXT,
  ADD COLUMN "hospital_number" TEXT,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "occupation" TEXT,
  ADD COLUMN "blood_group" TEXT,
  ADD COLUMN "address_ward" TEXT,
  ADD COLUMN "emergency_contact_name" TEXT,
  ADD COLUMN "emergency_contact_phone" TEXT,
  ADD COLUMN "emergency_contact_relationship" TEXT;

ALTER TABLE "emr_patients" ADD CONSTRAINT "emr_patients_payer_check"
  CHECK ("payer" IS NULL OR "payer" IN ('OUT_OF_POCKET', 'GOVERNMENT_SCHEME', 'NHIS', 'HMO', 'CORPORATE')) NOT VALID;
ALTER TABLE "emr_patients" VALIDATE CONSTRAINT "emr_patients_payer_check";
ALTER TABLE "emr_patients" ADD CONSTRAINT "emr_patients_blood_group_check"
  CHECK ("blood_group" IS NULL OR "blood_group" IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')) NOT VALID;
ALTER TABLE "emr_patients" VALIDATE CONSTRAINT "emr_patients_blood_group_check";
-- A legacy paper-file number identifies one patient within a hospital.
CREATE UNIQUE INDEX "emr_patients_organization_id_hospital_number_key" ON "emr_patients"("organization_id", "hospital_number")
  WHERE "hospital_number" IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Station queue
-- ---------------------------------------------------------------------------------------------
-- Declared most-urgent first, so ORDER BY "priority" calls emergencies first.
CREATE TYPE "EmrQueuePriority" AS ENUM ('EMERGENCY', 'URGENT', 'NORMAL');
CREATE TYPE "EmrQueueStatus" AS ENUM ('WAITING', 'IN_PROGRESS', 'COMPLETED', 'REFERRED');

CREATE TABLE "emr_queue_entries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "encounter_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "station" TEXT NOT NULL,
  "priority" "EmrQueuePriority" NOT NULL DEFAULT 'NORMAL',
  "status" "EmrQueueStatus" NOT NULL DEFAULT 'WAITING',
  "complaint" TEXT,
  "queued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "called_at" TIMESTAMP(3),
  "assigned_to_user_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_queue_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_queue_entries_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_queue_entries_one_per_visit_key" UNIQUE ("organization_id", "encounter_id"),
  CONSTRAINT "emr_queue_entries_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_queue_entries_station_check" CHECK (char_length("station") BETWEEN 1 AND 40),
  CONSTRAINT "emr_queue_entries_called_check" CHECK ("status" <> 'IN_PROGRESS' OR "called_at" IS NOT NULL)
);
-- Call-next: waiting patients at a station, most urgent first, then longest waiting.
CREATE INDEX "emr_queue_entries_call_next_idx" ON "emr_queue_entries"("organization_id", "station", "status", "priority", "queued_at", "id");
CREATE INDEX "emr_queue_entries_organization_id_status_idx" ON "emr_queue_entries"("organization_id", "status", "queued_at");

-- Every queue change, append-only (who moved whom where, and when).
CREATE TABLE "emr_queue_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "queue_entry_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "station" TEXT NOT NULL,
  "status" "EmrQueueStatus" NOT NULL,
  "priority" "EmrQueuePriority" NOT NULL,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_queue_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_queue_events_entry_fkey" FOREIGN KEY ("organization_id", "queue_entry_id") REFERENCES "emr_queue_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_queue_events_action_check" CHECK ("action" IN ('CHECKED_IN', 'MOVED', 'CALLED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'CLOSED'))
);
CREATE INDEX "emr_queue_events_organization_id_entry_idx" ON "emr_queue_events"("organization_id", "queue_entry_id", "created_at");
CREATE TRIGGER "emr_queue_events_append_only" BEFORE UPDATE OR DELETE ON "emr_queue_events"
  FOR EACH ROW EXECUTE FUNCTION emr_append_only();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_queue_entries', 'emr_queue_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON "emr_queue_entries" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_queue_events" TO sabi_emr_app;

-- Reception, nurses and doctors run the queue; lab and pharmacy staff see it (they call from it too).
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('queue.read', 'View the station queue'),
  ('queue.manage', 'Call, move and prioritise patients in the station queue')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('RECEPTIONIST', 'queue.read'),
  ('RECEPTIONIST', 'queue.manage'),
  ('NURSE', 'queue.read'),
  ('NURSE', 'queue.manage'),
  ('DOCTOR', 'queue.read'),
  ('DOCTOR', 'queue.manage'),
  ('LAB_SCIENTIST', 'queue.read'),
  ('LAB_SCIENTIST', 'queue.manage'),
  ('PHARMACIST', 'queue.read'),
  ('PHARMACIST', 'queue.manage'),
  ('HOSPITAL_ADMIN', 'queue.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
