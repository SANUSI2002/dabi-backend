-- Consultation notes for telemedicine appointments.
--
-- consultation_notes: one per doctor appointment. `draft` holds the private clinical sections and
-- the patient's visit summary; `revision` is the optimistic-concurrency counter; `signed_version`
-- is the latest signed version shown to the patient (NULL until first signed).
-- consultation_note_versions: every signed version, append-only. Amendments add a new version
-- with a reason; earlier versions are never changed or removed.
-- All additive: new tables, plus one unique constraint on doctor_appointments used by the
-- composite foreign key below.

CREATE TABLE "consultation_notes" (
    "id" TEXT NOT NULL,
    "appointment_id" TEXT NOT NULL,
    "doctor_profile_id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "draft" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "signed_version" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "consultation_notes_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consultation_notes_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "consultation_notes_signed_version_check" CHECK ("signed_version" IS NULL OR "signed_version" >= 1)
);

CREATE TABLE "consultation_note_versions" (
    "id" TEXT NOT NULL,
    "note_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "amendment_reason" VARCHAR(500),
    "signed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consultation_note_versions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "consultation_note_versions_number_check" CHECK ("number" >= 1),
    -- The first signature needs no reason; every amendment does.
    CONSTRAINT "consultation_note_versions_amendment_check" CHECK (("number" = 1) = ("amendment_reason" IS NULL))
);

CREATE UNIQUE INDEX "consultation_notes_appointment_id_key" ON "consultation_notes"("appointment_id");
CREATE INDEX "consultation_notes_doctor_profile_id_updated_at_idx" ON "consultation_notes"("doctor_profile_id", "updated_at");
CREATE INDEX "consultation_notes_patient_id_signed_version_idx" ON "consultation_notes"("patient_id", "signed_version");
CREATE UNIQUE INDEX "consultation_note_versions_note_id_number_key" ON "consultation_note_versions"("note_id", "number");

ALTER TABLE "consultation_notes" ADD CONSTRAINT "consultation_notes_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "doctor_appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consultation_notes" ADD CONSTRAINT "consultation_notes_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "professional_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consultation_notes" ADD CONSTRAINT "consultation_notes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consultation_note_versions" ADD CONSTRAINT "consultation_note_versions_note_id_fkey" FOREIGN KEY ("note_id") REFERENCES "consultation_notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A note's patient and doctor are always the appointment's patient and doctor.
ALTER TABLE "doctor_appointments" ADD CONSTRAINT "doctor_appointments_id_patient_doctor_key" UNIQUE ("id", "patient_id", "doctor_profile_id");
ALTER TABLE "consultation_notes" ADD CONSTRAINT "consultation_notes_appointment_parties_fkey"
  FOREIGN KEY ("appointment_id", "patient_id", "doctor_profile_id")
  REFERENCES "doctor_appointments"("id", "patient_id", "doctor_profile_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Signed versions are a clinical record: never edited, never deleted.
CREATE OR REPLACE FUNCTION consultation_note_versions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'consultation_note_versions is append-only';
END $$;
CREATE TRIGGER "consultation_note_versions_no_change" BEFORE UPDATE OR DELETE ON "consultation_note_versions"
  FOR EACH ROW EXECUTE FUNCTION consultation_note_versions_append_only();
