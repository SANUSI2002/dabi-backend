-- EMR laboratory: per-tenant test catalog, orders (tests snapshotted at order time), specimen
-- collection with per-tenant accession numbers, results with server-computed flags, verification,
-- and append-only amendment history. Same tenancy rules as the other EMR migrations.
-- All objects are new; nothing here locks an existing table.

CREATE TYPE "EmrLabPriority" AS ENUM ('ROUTINE', 'URGENT', 'STAT');
CREATE TYPE "EmrLabOrderStatus" AS ENUM ('ORDERED', 'COLLECTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');
CREATE TYPE "EmrLabItemStatus" AS ENUM ('PENDING', 'RESULTED', 'VERIFIED');
CREATE TYPE "EmrLabResultStatus" AS ENUM ('PRELIMINARY', 'FINAL', 'SUPERSEDED');
CREATE TYPE "EmrLabFlag" AS ENUM ('NORMAL', 'LOW', 'HIGH', 'CRITICAL_LOW', 'CRITICAL_HIGH', 'ABNORMAL');

-- ---------------------------------------------------------------------------------------------
-- Per-tenant counters (accession numbers). One row per (tenant, name): contention stays inside
-- one organization — a busy lab never slows another tenant.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_sequences" (
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "value" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "emr_sequences_pkey" PRIMARY KEY ("organization_id", "name"),
  CONSTRAINT "emr_sequences_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- Test catalog (per tenant). Analytes are JSON: code, name, kind, unit, reference/critical ranges.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_lab_tests" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "specimen_type" TEXT NOT NULL,
  "analytes" JSONB NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_lab_tests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_lab_tests_organization_id_code_key" UNIQUE ("organization_id", "code"),
  CONSTRAINT "emr_lab_tests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_lab_orders" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "encounter_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "status" "EmrLabOrderStatus" NOT NULL DEFAULT 'ORDERED',
  "priority" "EmrLabPriority" NOT NULL DEFAULT 'ROUTINE',
  "clinical_notes" TEXT,
  "accession_number" TEXT,
  "ordered_by_user_id" TEXT NOT NULL,
  "collected_by_user_id" TEXT,
  "collected_at" TIMESTAMP(3),
  "specimen_note" TEXT,
  "cancelled_by_user_id" TEXT,
  "cancelled_at" TIMESTAMP(3),
  "cancellation_reason" TEXT,
  "completed_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_lab_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_lab_orders_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_lab_orders_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_lab_orders_collected_check" CHECK ("status" IN ('ORDERED', 'CANCELLED') OR "accession_number" IS NOT NULL),
  CONSTRAINT "emr_lab_orders_cancel_check" CHECK ("status" <> 'CANCELLED' OR "cancellation_reason" IS NOT NULL)
);
CREATE UNIQUE INDEX "emr_lab_orders_accession_key" ON "emr_lab_orders"("organization_id", "accession_number") WHERE "accession_number" IS NOT NULL;
CREATE INDEX "emr_lab_orders_organization_id_worklist_idx" ON "emr_lab_orders"("organization_id", "status", "created_at" DESC, "id" DESC);
CREATE INDEX "emr_lab_orders_organization_id_created_at_idx" ON "emr_lab_orders"("organization_id", "created_at" DESC, "id" DESC);
CREATE INDEX "emr_lab_orders_organization_id_encounter_idx" ON "emr_lab_orders"("organization_id", "encounter_id");
CREATE INDEX "emr_lab_orders_organization_id_patient_idx" ON "emr_lab_orders"("organization_id", "patient_id", "created_at" DESC);

-- One row per ordered test. `analytes` is a snapshot of the catalog definition at order time, so
-- later catalog edits never change what was ordered or how it is interpreted.
CREATE TABLE "emr_lab_order_items" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "test_code" TEXT NOT NULL,
  "test_name" TEXT NOT NULL,
  "specimen_type" TEXT NOT NULL,
  "analytes" JSONB NOT NULL,
  "status" "EmrLabItemStatus" NOT NULL DEFAULT 'PENDING',
  "resulted_by_user_id" TEXT,
  "resulted_at" TIMESTAMP(3),
  "verified_by_user_id" TEXT,
  "verified_at" TIMESTAMP(3),
  "amended_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_lab_order_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_lab_order_items_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_lab_order_items_order_fkey" FOREIGN KEY ("organization_id", "order_id") REFERENCES "emr_lab_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_lab_order_items_one_test_key" UNIQUE ("organization_id", "order_id", "test_code")
);

-- ---------------------------------------------------------------------------------------------
-- Results: PRELIMINARY (editable by re-entry) → FINAL (locked) → SUPERSEDED (by an amendment).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_lab_results" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "analyte_code" TEXT NOT NULL,
  "analyte_name" TEXT NOT NULL,
  "value_numeric" NUMERIC(14, 4),
  "value_text" TEXT,
  "unit" TEXT,
  "reference_low" NUMERIC(14, 4),
  "reference_high" NUMERIC(14, 4),
  "flag" "EmrLabFlag",
  "status" "EmrLabResultStatus" NOT NULL DEFAULT 'PRELIMINARY',
  "entered_by_user_id" TEXT NOT NULL,
  "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "amendment_reason" TEXT,
  "superseded_by_user_id" TEXT,
  "superseded_at" TIMESTAMP(3),
  CONSTRAINT "emr_lab_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_lab_results_item_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "emr_lab_order_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_lab_results_value_check" CHECK ("value_numeric" IS NOT NULL OR "value_text" IS NOT NULL)
);
CREATE INDEX "emr_lab_results_organization_id_item_idx" ON "emr_lab_results"("organization_id", "item_id", "status");
-- At most one current (non-superseded) value per analyte per test.
CREATE UNIQUE INDEX "emr_lab_results_current_key" ON "emr_lab_results"("organization_id", "item_id", "analyte_code")
  WHERE "status" <> 'SUPERSEDED';

-- Released results are immutable: the only permitted change is FINAL → SUPERSEDED (values
-- untouched). Only PRELIMINARY rows may be deleted (re-entry before verification).
CREATE OR REPLACE FUNCTION emr_lab_results_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" <> 'PRELIMINARY' THEN
      RAISE EXCEPTION 'A released lab result cannot be deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."status" = 'PRELIMINARY' THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'FINAL' AND NEW."status" = 'SUPERSEDED'
     AND NEW."value_numeric" IS NOT DISTINCT FROM OLD."value_numeric"
     AND NEW."value_text" IS NOT DISTINCT FROM OLD."value_text"
     AND NEW."flag" IS NOT DISTINCT FROM OLD."flag"
     AND NEW."analyte_code" = OLD."analyte_code" AND NEW."item_id" = OLD."item_id" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A released lab result cannot be changed; amend it instead';
END $$;
CREATE TRIGGER "emr_lab_results_guard" BEFORE UPDATE OR DELETE ON "emr_lab_results"
  FOR EACH ROW EXECUTE FUNCTION emr_lab_results_guard();

-- ---------------------------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "emr_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_sequences_tenant" ON "emr_sequences"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_lab_tests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_lab_tests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_lab_tests_tenant" ON "emr_lab_tests"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_lab_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_lab_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_lab_orders_tenant" ON "emr_lab_orders"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_lab_order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_lab_order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_lab_order_items_tenant" ON "emr_lab_order_items"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_lab_results" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_lab_results" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_lab_results_tenant" ON "emr_lab_results"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());

GRANT SELECT, INSERT, UPDATE ON "emr_sequences" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_lab_tests" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_lab_orders" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_lab_order_items" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "emr_lab_results" TO sabi_emr_app; -- DELETE: preliminary only (trigger)

-- ---------------------------------------------------------------------------------------------
-- Permissions. lab.order.create (DOCTOR) and lab.result.create (LAB_SCIENTIST) already exist.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('lab.order.read', 'View laboratory orders and results'),
  ('lab.specimen.collect', 'Collect and label laboratory specimens'),
  ('lab.result.verify', 'Verify, release and amend laboratory results'),
  ('lab.catalog.manage', 'Manage the laboratory test catalog')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'lab.order.read'),
  ('NURSE', 'lab.order.read'),
  ('NURSE', 'lab.specimen.collect'),
  ('LAB_SCIENTIST', 'lab.order.read'),
  ('LAB_SCIENTIST', 'lab.specimen.collect'),
  ('LAB_SCIENTIST', 'lab.result.verify'),
  ('LAB_SCIENTIST', 'lab.catalog.manage'),
  ('HOSPITAL_ADMIN', 'lab.catalog.manage')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
