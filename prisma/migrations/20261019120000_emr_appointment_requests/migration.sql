-- Appointment requests patients make in the Sabi app (hospital_appointments) reach the hospital's
-- EMR desk. Confirming one books an EMR appointment and marks the request SCHEDULED in the same
-- transaction; check-in and cancellation at the desk are passed back to the request.

-- The booking a request became. One booking per request, ever; never changed afterwards (the
-- column is not in the EMR role's UPDATE grant).
ALTER TABLE "emr_appointments" ADD COLUMN "request_id" TEXT;
CREATE UNIQUE INDEX "emr_appointments_request_id_key" ON "emr_appointments"("request_id");
ALTER TABLE "emr_appointments" ADD CONSTRAINT "emr_appointments_request_fkey"
  FOREIGN KEY ("request_id") REFERENCES "hospital_appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The EMR role reaches hospital_appointments only through this view, which shows a tenant just
-- the requests made to its own hospital (the Organisation its identity organization stands for).
-- hospital_appointments itself keeps no row-level security: the patient app reads and writes it
-- with the application's own role. The view runs with its owner's rights, so the EMR role needs
-- no grant on hospital_appointments or identity_organizations; CHECK OPTION keeps every update
-- inside the tenant's hospital.
CREATE VIEW "emr_appointment_requests" WITH (security_barrier = true) AS
  SELECT "id", "hospital_id", "patient_id" AS "user_id", "dependent_id", "status", "requested_at", "appointment_type", "reason",
    "decision_reason", "decided_at", "decided_by_user_id", "checked_in_at", "created_at", "updated_at"
  FROM "hospital_appointments"
  WHERE "hospital_id" = (SELECT "organisation_id" FROM "identity_organizations" WHERE "id" = emr_current_organization())
  WITH CASCADED CHECK OPTION;

-- Read; decide (status, reason, who, when); pass back a check-in or a cancellation. What the patient
-- asked for (who, when, type, reason) is never changed from the EMR.
GRANT SELECT ON "emr_appointment_requests" TO sabi_emr_app;
GRANT UPDATE ("status", "decision_reason", "decided_at", "decided_by_user_id", "checked_in_at", "updated_at")
  ON "emr_appointment_requests" TO sabi_emr_app;
