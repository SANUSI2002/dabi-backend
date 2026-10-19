-- Patient transfers of care between facilities (distinct from clinical referrals). OUT transfers are of a
-- patient on this register; IN transfers record the person as received (they are registered separately).
-- Completing an OUT transfer records that a staff member handed the records over — no electronic
-- transmission to the other facility happens here. PENDING → COMPLETED | CANCELLED; never deleted.

CREATE TABLE "emr_patient_transfers" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "direction" VARCHAR(3) NOT NULL,
  "patient_id" TEXT,
  "patient_name" VARCHAR(160) NOT NULL,
  "facility" VARCHAR(200) NOT NULL,
  "reason" VARCHAR(40) NOT NULL,
  "summary" VARCHAR(4000),
  "status" VARCHAR(9) NOT NULL DEFAULT 'PENDING',
  "records_sent" BOOLEAN NOT NULL DEFAULT false,
  "initiated_by_user_id" TEXT NOT NULL,
  "completed_by_user_id" TEXT,
  "completed_at" TIMESTAMP(3),
  "cancelled_by_user_id" TEXT,
  "cancelled_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_patient_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_patient_transfers_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_patient_transfers_values_check" CHECK (
    "direction" IN ('IN', 'OUT') AND "status" IN ('PENDING', 'COMPLETED', 'CANCELLED') AND
    "reason" IN ('Relocation', 'Catchment reassignment', 'Service not available here', 'Patient request', 'Higher level of care') AND
    ("direction" <> 'OUT' OR "patient_id" IS NOT NULL) AND
    ("status" <> 'COMPLETED' OR ("completed_by_user_id" IS NOT NULL AND "completed_at" IS NOT NULL)) AND
    ("status" <> 'CANCELLED' OR ("cancelled_by_user_id" IS NOT NULL AND "cancelled_at" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "emr_patient_transfers_one_pending_out_key" ON "emr_patient_transfers"("organization_id", "patient_id") WHERE "direction" = 'OUT' AND "status" = 'PENDING';
CREATE INDEX "emr_patient_transfers_organization_id_created_at_idx" ON "emr_patient_transfers"("organization_id", "created_at");

ALTER TABLE "emr_patient_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_patient_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_patient_transfers_tenant" ON "emr_patient_transfers" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_patient_transfers" TO sabi_emr_app;
GRANT UPDATE ("status", "records_sent", "completed_by_user_id", "completed_at", "cancelled_by_user_id", "cancelled_at", "version", "updated_at") ON "emr_patient_transfers" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('transfer.read', 'View patient transfers of care'),
  ('transfer.manage', 'Record, complete and cancel patient transfers of care')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'transfer.read'), ('DOCTOR', 'transfer.manage'),
  ('NURSE', 'transfer.read'), ('NURSE', 'transfer.manage'),
  ('RECEPTIONIST', 'transfer.read'), ('RECEPTIONIST', 'transfer.manage'),
  ('HOSPITAL_ADMIN', 'transfer.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
