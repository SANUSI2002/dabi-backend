-- Hospital appointments: booked for a patient (optionally with a clinician), then checked in
-- (which opens or reuses the patient's visit), marked no-show, or cancelled. Never deleted.
ALTER TYPE "EmrEncounterSource" ADD VALUE IF NOT EXISTS 'APPOINTMENT';

CREATE TABLE "emr_appointments" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "scheduled_at" TIMESTAMP(3) NOT NULL,
  "type" VARCHAR(20) NOT NULL DEFAULT 'GENERAL',
  "provider_user_id" TEXT,
  "reason" VARCHAR(300),
  "status" VARCHAR(20) NOT NULL DEFAULT 'SCHEDULED',
  "encounter_id" TEXT,
  "booked_by_user_id" TEXT NOT NULL,
  "checked_in_at" TIMESTAMP(3),
  "checked_in_by_user_id" TEXT,
  "no_show_at" TIMESTAMP(3),
  "no_show_by_user_id" TEXT,
  "cancelled_at" TIMESTAMP(3),
  "cancelled_by_user_id" TEXT,
  "cancellation_reason" VARCHAR(300),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_appointments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_appointments_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_appointments_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_appointments_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_appointments_type_check" CHECK ("type" IN ('GENERAL', 'ANC', 'PNC', 'FOLLOW_UP', 'IMMUNIZATION', 'SPECIALIST')),
  CONSTRAINT "emr_appointments_status_check" CHECK ("status" IN ('SCHEDULED', 'ATTENDED', 'NO_SHOW', 'CANCELLED')),
  -- Each outcome carries who and when; an attended appointment points at its visit.
  CONSTRAINT "emr_appointments_outcome_check" CHECK (
    ("status" <> 'ATTENDED' OR ("encounter_id" IS NOT NULL AND "checked_in_at" IS NOT NULL AND "checked_in_by_user_id" IS NOT NULL)) AND
    ("status" <> 'NO_SHOW' OR ("no_show_at" IS NOT NULL AND "no_show_by_user_id" IS NOT NULL)) AND
    ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL))
  )
);
CREATE INDEX "emr_appointments_organization_id_scheduled_at_id_idx" ON "emr_appointments"("organization_id", "scheduled_at", "id");
CREATE INDEX "emr_appointments_organization_id_patient_id_scheduled_at_idx" ON "emr_appointments"("organization_id", "patient_id", "scheduled_at");
-- A patient cannot hold two live bookings for the same moment.
CREATE UNIQUE INDEX "emr_appointments_patient_slot_key" ON "emr_appointments"("organization_id", "patient_id", "scheduled_at") WHERE "status" = 'SCHEDULED';

ALTER TABLE "emr_appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_appointments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_appointments_tenant" ON "emr_appointments"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

-- No DELETE; what was booked (patient, time, type, provider, reason) never changes afterwards.
GRANT SELECT, INSERT ON "emr_appointments" TO sabi_emr_app;
GRANT UPDATE ("status", "encounter_id", "checked_in_at", "checked_in_by_user_id", "no_show_at", "no_show_by_user_id",
  "cancelled_at", "cancelled_by_user_id", "cancellation_reason", "version", "updated_at") ON "emr_appointments" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('appointment.read', 'View hospital appointments'),
  ('appointment.manage', 'Book, check in, mark no-show and cancel hospital appointments')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('RECEPTIONIST', 'appointment.read'),
  ('RECEPTIONIST', 'appointment.manage'),
  ('NURSE', 'appointment.read'),
  ('NURSE', 'appointment.manage'),
  ('DOCTOR', 'appointment.read'),
  ('DOCTOR', 'appointment.manage'),
  ('HOSPITAL_ADMIN', 'appointment.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
