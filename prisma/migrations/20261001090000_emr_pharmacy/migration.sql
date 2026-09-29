-- EMR prescribing, pharmacy stock and dispensing.
--   * per-tenant formulary and patient allergies (inputs to prescribing safety checks)
--   * prescriptions: prescribe → pharmacist review → dispense (partial allowed) → returns
--   * stock: batches with expiry, an append-only movement ledger, FEFO allocation
-- Invariants enforced by the database, not only the application:
--   stock never negative; dispensed never exceeds prescribed; returned never exceeds dispensed;
--   the ledger is append-only; tenants are isolated by RLS and composite foreign keys.
-- All objects are new; nothing here locks an existing table.

CREATE TYPE "EmrPrescriptionStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'PARTIALLY_DISPENSED', 'DISPENSED', 'REJECTED', 'CANCELLED');
CREATE TYPE "EmrPrescriptionItemStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "EmrStockMovementKind" AS ENUM ('RECEIPT', 'DISPENSE', 'RETURN', 'ADJUSTMENT');
CREATE TYPE "EmrAllergySeverity" AS ENUM ('MILD', 'MODERATE', 'SEVERE');

-- ---------------------------------------------------------------------------------------------
-- Formulary (per tenant). drug_classes drive allergy-class and duplicate-therapy checks.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_formulary_items" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "generic_name" TEXT NOT NULL,
  "brand_name" TEXT,
  "form" TEXT NOT NULL,
  "strength" TEXT NOT NULL,
  "dose_unit" TEXT NOT NULL,
  "dispense_unit" TEXT NOT NULL,
  "dose_per_dispense_unit" NUMERIC(12, 4),
  "max_daily_dose" NUMERIC(12, 4),
  "default_route" TEXT NOT NULL,
  "drug_classes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "controlled" BOOLEAN NOT NULL DEFAULT false,
  "high_alert" BOOLEAN NOT NULL DEFAULT false,
  "reorder_level" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_formulary_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_formulary_items_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_formulary_items_organization_id_code_key" UNIQUE ("organization_id", "code"),
  CONSTRAINT "emr_formulary_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_formulary_items_numbers_check" CHECK (
    ("dose_per_dispense_unit" IS NULL OR "dose_per_dispense_unit" > 0)
    AND ("max_daily_dose" IS NULL OR "max_daily_dose" > 0)
    AND "reorder_level" >= 0)
);

-- ---------------------------------------------------------------------------------------------
-- Patient allergies. Never edited: wrong entries are marked ENTERED_IN_ERROR.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_patient_allergies" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "substance" TEXT NOT NULL,
  "substance_code" TEXT NOT NULL,
  "reaction" TEXT,
  "severity" "EmrAllergySeverity" NOT NULL DEFAULT 'MODERATE',
  "status" "EmrEntryStatus" NOT NULL DEFAULT 'ACTIVE',
  "recorded_by_user_id" TEXT NOT NULL,
  "error_reason" TEXT,
  "errored_by_user_id" TEXT,
  "errored_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_patient_allergies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_patient_allergies_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_patient_allergies_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_patient_allergies_error_check" CHECK ("status" = 'ACTIVE' OR "error_reason" IS NOT NULL)
);
CREATE INDEX "emr_patient_allergies_organization_id_patient_idx" ON "emr_patient_allergies"("organization_id", "patient_id", "status");
-- One active entry per substance per patient.
CREATE UNIQUE INDEX "emr_patient_allergies_active_key" ON "emr_patient_allergies"("organization_id", "patient_id", "substance_code") WHERE "status" = 'ACTIVE';

-- ---------------------------------------------------------------------------------------------
-- Prescriptions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_prescriptions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "encounter_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "status" "EmrPrescriptionStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  "notes" TEXT,
  "prescriber_user_id" TEXT NOT NULL,
  "reviewed_by_user_id" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "review_note" TEXT,
  "rejection_reason" TEXT,
  "cancelled_by_user_id" TEXT,
  "cancelled_at" TIMESTAMP(3),
  "cancellation_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_prescriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_prescriptions_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_prescriptions_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_prescriptions_rejected_check" CHECK ("status" <> 'REJECTED' OR "rejection_reason" IS NOT NULL),
  CONSTRAINT "emr_prescriptions_cancelled_check" CHECK ("status" <> 'CANCELLED' OR "cancellation_reason" IS NOT NULL)
);
CREATE INDEX "emr_prescriptions_organization_id_queue_idx" ON "emr_prescriptions"("organization_id", "status", "created_at", "id");
CREATE INDEX "emr_prescriptions_organization_id_encounter_idx" ON "emr_prescriptions"("organization_id", "encounter_id");
CREATE INDEX "emr_prescriptions_organization_id_patient_idx" ON "emr_prescriptions"("organization_id", "patient_id", "created_at" DESC);

CREATE TABLE "emr_prescription_items" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "prescription_id" TEXT NOT NULL,
  "formulary_item_id" TEXT NOT NULL,
  "drug_code" TEXT NOT NULL,
  "drug_name" TEXT NOT NULL,
  "strength" TEXT NOT NULL,
  "form" TEXT NOT NULL,
  "dose" NUMERIC(12, 4) NOT NULL,
  "dose_unit" TEXT NOT NULL,
  "frequency" TEXT NOT NULL,
  "route" TEXT NOT NULL,
  "duration_days" INTEGER,
  "prn" BOOLEAN NOT NULL DEFAULT false,
  "prn_reason" TEXT,
  "instructions" TEXT,
  "dispense_unit" TEXT NOT NULL,
  "quantity_prescribed" INTEGER NOT NULL,
  "quantity_dispensed" INTEGER NOT NULL DEFAULT 0,
  "status" "EmrPrescriptionItemStatus" NOT NULL DEFAULT 'ACTIVE',
  "controlled" BOOLEAN NOT NULL DEFAULT false,
  "safety_alerts" JSONB NOT NULL DEFAULT '[]',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_prescription_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_prescription_items_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_prescription_items_prescription_fkey" FOREIGN KEY ("organization_id", "prescription_id") REFERENCES "emr_prescriptions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_prescription_items_formulary_fkey" FOREIGN KEY ("organization_id", "formulary_item_id") REFERENCES "emr_formulary_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_prescription_items_one_drug_key" UNIQUE ("organization_id", "prescription_id", "formulary_item_id"),
  CONSTRAINT "emr_prescription_items_quantity_check" CHECK (
    "dose" > 0 AND "quantity_prescribed" > 0 AND "quantity_dispensed" >= 0
    AND "quantity_dispensed" <= "quantity_prescribed"
    AND ("duration_days" IS NULL OR "duration_days" BETWEEN 1 AND 365))
);
CREATE INDEX "emr_prescription_items_organization_id_prescription_idx" ON "emr_prescription_items"("organization_id", "prescription_id");
CREATE INDEX "emr_prescription_items_organization_id_formulary_idx" ON "emr_prescription_items"("organization_id", "formulary_item_id", "status");

-- ---------------------------------------------------------------------------------------------
-- Stock: batches + append-only movement ledger
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_stock_batches" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "formulary_item_id" TEXT NOT NULL,
  "batch_number" TEXT NOT NULL,
  "expiry_date" DATE NOT NULL,
  "quantity_on_hand" INTEGER NOT NULL DEFAULT 0,
  "unit_cost_minor" INTEGER,
  "supplier" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_stock_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_stock_batches_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_stock_batches_identity_key" UNIQUE ("organization_id", "formulary_item_id", "batch_number", "expiry_date"),
  CONSTRAINT "emr_stock_batches_formulary_fkey" FOREIGN KEY ("organization_id", "formulary_item_id") REFERENCES "emr_formulary_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_stock_batches_quantity_check" CHECK ("quantity_on_hand" >= 0 AND ("unit_cost_minor" IS NULL OR "unit_cost_minor" >= 0))
);
-- FEFO allocation: a drug's batches in expiry order.
CREATE INDEX "emr_stock_batches_organization_id_fefo_idx" ON "emr_stock_batches"("organization_id", "formulary_item_id", "expiry_date", "id");

CREATE TABLE "emr_dispenses" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "prescription_id" TEXT NOT NULL,
  "dispensed_by_user_id" TEXT NOT NULL,
  "witness_user_id" TEXT,
  "note" TEXT,
  "dispensed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_dispenses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_dispenses_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_dispenses_prescription_fkey" FOREIGN KEY ("organization_id", "prescription_id") REFERENCES "emr_prescriptions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_dispenses_witness_check" CHECK ("witness_user_id" IS NULL OR "witness_user_id" <> "dispensed_by_user_id")
);
CREATE INDEX "emr_dispenses_organization_id_prescription_idx" ON "emr_dispenses"("organization_id", "prescription_id", "dispensed_at");

CREATE TABLE "emr_dispense_lines" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "dispense_id" TEXT NOT NULL,
  "prescription_item_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "quantity_returned" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "emr_dispense_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_dispense_lines_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_dispense_lines_dispense_fkey" FOREIGN KEY ("organization_id", "dispense_id") REFERENCES "emr_dispenses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_dispense_lines_item_fkey" FOREIGN KEY ("organization_id", "prescription_item_id") REFERENCES "emr_prescription_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_dispense_lines_batch_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "emr_stock_batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_dispense_lines_quantity_check" CHECK ("quantity" > 0 AND "quantity_returned" >= 0 AND "quantity_returned" <= "quantity")
);
CREATE INDEX "emr_dispense_lines_organization_id_dispense_idx" ON "emr_dispense_lines"("organization_id", "dispense_id");

CREATE TABLE "emr_stock_movements" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "formulary_item_id" TEXT NOT NULL,
  "kind" "EmrStockMovementKind" NOT NULL,
  "quantity" INTEGER NOT NULL,
  "balance_after" INTEGER NOT NULL,
  "reason" TEXT,
  "dispense_id" TEXT,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_stock_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_stock_movements_batch_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "emr_stock_batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_stock_movements_formulary_fkey" FOREIGN KEY ("organization_id", "formulary_item_id") REFERENCES "emr_formulary_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_stock_movements_dispense_fkey" FOREIGN KEY ("organization_id", "dispense_id") REFERENCES "emr_dispenses"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_stock_movements_quantity_check" CHECK (
    "quantity" <> 0 AND "balance_after" >= 0
    AND ("kind" <> 'RECEIPT' OR "quantity" > 0)
    AND ("kind" <> 'DISPENSE' OR ("quantity" < 0 AND "dispense_id" IS NOT NULL))
    AND ("kind" <> 'RETURN' OR ("quantity" > 0 AND "dispense_id" IS NOT NULL))
    AND ("kind" <> 'ADJUSTMENT' OR "reason" IS NOT NULL))
);
CREATE INDEX "emr_stock_movements_organization_id_item_idx" ON "emr_stock_movements"("organization_id", "formulary_item_id", "created_at" DESC, "id" DESC);
CREATE INDEX "emr_stock_movements_organization_id_batch_idx" ON "emr_stock_movements"("organization_id", "batch_id", "created_at");
CREATE TRIGGER "emr_stock_movements_append_only" BEFORE UPDATE OR DELETE ON "emr_stock_movements"
  FOR EACH ROW EXECUTE FUNCTION emr_append_only();

-- ---------------------------------------------------------------------------------------------
-- Row-level security (clinical/stock data: tenant only, no worker clause)
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_formulary_items', 'emr_patient_allergies', 'emr_prescriptions', 'emr_prescription_items',
                           'emr_stock_batches', 'emr_dispenses', 'emr_dispense_lines', 'emr_stock_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON "emr_formulary_items" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_patient_allergies" TO sabi_emr_app;
GRANT UPDATE ("status", "error_reason", "errored_by_user_id", "errored_at") ON "emr_patient_allergies" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_prescriptions" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_prescription_items" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_stock_batches" TO sabi_emr_app;
GRANT UPDATE ("quantity_on_hand", "version", "updated_at", "unit_cost_minor", "supplier") ON "emr_stock_batches" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_dispenses" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_dispense_lines" TO sabi_emr_app;
GRANT UPDATE ("quantity_returned") ON "emr_dispense_lines" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_stock_movements" TO sabi_emr_app;

-- ---------------------------------------------------------------------------------------------
-- Permissions. prescription.create (DOCTOR) and prescription.dispense (PHARMACIST) already exist.
-- Stock uses EMR-specific codes so the retail-pharmacy inventory permissions keep their meaning.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('prescription.read', 'View prescriptions and a patient''s medication list'),
  ('prescription.review', 'Review (approve or reject) prescriptions as a pharmacist'),
  ('allergy.record', 'Record patient allergies'),
  ('emr.stock.view', 'View hospital pharmacy stock and the formulary'),
  ('emr.stock.manage', 'Receive and adjust hospital pharmacy stock'),
  ('emr.formulary.manage', 'Manage the hospital formulary')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'prescription.read'),
  ('DOCTOR', 'allergy.record'),
  ('DOCTOR', 'emr.stock.view'),
  ('NURSE', 'prescription.read'),
  ('NURSE', 'allergy.record'),
  ('PHARMACIST', 'prescription.read'),
  ('PHARMACIST', 'prescription.review'),
  ('PHARMACIST', 'allergy.record'),
  ('PHARMACIST', 'emr.stock.view'),
  ('PHARMACIST', 'emr.stock.manage'),
  ('PHARMACIST', 'emr.formulary.manage'),
  ('INVENTORY_OFFICER', 'emr.stock.view'),
  ('INVENTORY_OFFICER', 'emr.stock.manage'),
  ('HOSPITAL_ADMIN', 'emr.stock.view'),
  ('HOSPITAL_ADMIN', 'emr.formulary.manage')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
