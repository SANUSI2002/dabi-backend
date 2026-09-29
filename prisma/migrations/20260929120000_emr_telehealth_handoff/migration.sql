-- Telemedicine → EMR handoff (UC-2), decoupled through a domain event.
--
-- 1. domain_events: a small cross-module outbox. Telemedicine writes
--    "doctor_appointment.completed" in the same transaction that completes the appointment; it
--    knows nothing about the EMR. Payloads carry identifiers only.
-- 2. professional_profiles.emr_organization_id: the one EMR organization a doctor designates to
--    receive their telehealth visits (a doctor can belong to several hospitals).
-- 3. emr_telehealth_handoffs: exactly one recorded outcome per appointment — the encounter that
--    was created, or why none was (never guessed). A system table: identifiers only, written by
--    the EMR worker, no patient data.
-- All additive: a new nullable column (instant) and new tables.

CREATE TABLE "domain_events" (
  "id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "domain_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "domain_events_type_created_at_idx" ON "domain_events"("type", "created_at");

ALTER TABLE "professional_profiles" ADD COLUMN "emr_organization_id" TEXT;
ALTER TABLE "professional_profiles" ADD CONSTRAINT "professional_profiles_emr_organization_id_fkey"
  FOREIGN KEY ("emr_organization_id") REFERENCES "identity_organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "emr_telehealth_handoffs" (
  "appointment_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "organization_id" TEXT,
  "encounter_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_telehealth_handoffs_pkey" PRIMARY KEY ("appointment_id"),
  CONSTRAINT "emr_telehealth_handoffs_event_key" UNIQUE ("event_id"),
  CONSTRAINT "emr_telehealth_handoffs_appointment_fkey" FOREIGN KEY ("appointment_id") REFERENCES "doctor_appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_telehealth_handoffs_event_fkey" FOREIGN KEY ("event_id") REFERENCES "domain_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_telehealth_handoffs_organization_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_telehealth_handoffs_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id") REFERENCES "emr_encounters"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_telehealth_handoffs_outcome_check" CHECK ("outcome" IN (
    'ENCOUNTER_CREATED', 'SKIPPED_NO_DESIGNATED_ORGANIZATION', 'SKIPPED_NOT_A_MEMBER', 'SKIPPED_NO_EMR_ENTITLEMENT',
    'SKIPPED_NO_LINKED_PATIENT', 'SKIPPED_PATIENT_INACTIVE', 'SKIPPED_DEPENDENT', 'SKIPPED_NOT_COMPLETED')),
  CONSTRAINT "emr_telehealth_handoffs_encounter_check" CHECK (("outcome" = 'ENCOUNTER_CREATED') = ("encounter_id" IS NOT NULL))
);
CREATE INDEX "emr_telehealth_handoffs_organization_idx" ON "emr_telehealth_handoffs"("organization_id", "created_at");
