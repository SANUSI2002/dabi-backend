-- Hospital stores (general inventory: consumables, reagents, PPE, linen, devices… — the pharmacy's
-- formulary stock stays in emr_drug_batches). Stock is held as batches per storage location (with
-- batch number, expiry and unit cost); every change is an insert-only movement. Issue and transfer
-- take First-Expiry-First-Out; quarantined and expired batches are never issued or moved. Wards and
-- departments raise requisitions (submit → approve/reject → fulfil, partly or fully, which moves the
-- stock); stock counts snapshot the system quantity and post the variance as adjustments.
-- Money is BIGINT minor units (kobo).

CREATE TABLE "emr_store_locations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "code" VARCHAR(12) NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "type" VARCHAR(10) NOT NULL,
  "status" VARCHAR(8) NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_store_locations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_store_locations_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_store_locations_values_check" CHECK ("type" IN ('STORE', 'DEPARTMENT', 'WARD') AND "status" IN ('ACTIVE', 'INACTIVE') AND "code" ~ '^[A-Z][A-Z0-9_]{0,11}$')
);
CREATE UNIQUE INDEX "emr_store_locations_organization_id_code_key" ON "emr_store_locations"("organization_id", "code");

CREATE TABLE "emr_store_items" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "sku" VARCHAR(30) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "category" VARCHAR(20) NOT NULL,
  "unit" VARCHAR(20) NOT NULL,
  "min_level" INTEGER,
  "reorder_level" INTEGER NOT NULL DEFAULT 0,
  "reorder_qty" INTEGER,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_store_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_store_items_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_store_items_values_check" CHECK (
    "category" IN ('Drugs', 'Consumables', 'Reagents', 'Other', 'PPE', 'Surgical Supplies', 'Linen', 'Medical Devices') AND
    "reorder_level" >= 0 AND ("min_level" IS NULL OR "min_level" >= 0) AND ("reorder_qty" IS NULL OR "reorder_qty" > 0)
  )
);
CREATE UNIQUE INDEX "emr_store_items_organization_id_sku_key" ON "emr_store_items"("organization_id", "sku");

CREATE TABLE "emr_store_batches" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "location_id" TEXT NOT NULL,
  "batch_number" VARCHAR(60),
  "expiry_date" DATE,
  "qty_received" INTEGER NOT NULL,
  "qty_remaining" INTEGER NOT NULL,
  "unit_cost_minor" BIGINT NOT NULL,
  "status" VARCHAR(11) NOT NULL DEFAULT 'ACTIVE',
  "quarantine_reason" VARCHAR(300),
  "quarantined_by_user_id" TEXT,
  "quarantined_at" TIMESTAMP(3),
  "source" VARCHAR(10) NOT NULL,
  "reference" VARCHAR(80),
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_store_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_store_batches_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_store_batches_item_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "emr_store_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_batches_location_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "emr_store_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_batches_values_check" CHECK (
    "qty_received" > 0 AND "qty_remaining" BETWEEN 0 AND "qty_received" AND "unit_cost_minor" >= 0 AND
    "status" IN ('ACTIVE', 'QUARANTINED') AND "source" IN ('RECEIPT', 'TRANSFER', 'ADJUSTMENT', 'COUNT') AND
    ("status" <> 'QUARANTINED' OR ("quarantine_reason" IS NOT NULL AND "quarantined_by_user_id" IS NOT NULL AND "quarantined_at" IS NOT NULL))
  )
);
CREATE INDEX "emr_store_batches_item_idx" ON "emr_store_batches"("organization_id", "item_id", "location_id");

CREATE TABLE "emr_store_requisitions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "number" VARCHAR(20) NOT NULL,
  "requesting_location_id" TEXT NOT NULL,
  "fulfilling_location_id" TEXT,
  "needed_by" DATE,
  "justification" VARCHAR(500),
  "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
  "requested_by_user_id" TEXT NOT NULL,
  "decided_by_user_id" TEXT,
  "decided_at" TIMESTAMP(3),
  "rejection_reason" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_store_requisitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_store_requisitions_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_store_requisitions_requesting_fkey" FOREIGN KEY ("organization_id", "requesting_location_id") REFERENCES "emr_store_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_requisitions_fulfilling_fkey" FOREIGN KEY ("organization_id", "fulfilling_location_id") REFERENCES "emr_store_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_requisitions_values_check" CHECK (
    "status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'CANCELLED') AND
    ("status" <> 'REJECTED' OR "rejection_reason" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "emr_store_requisitions_organization_id_number_key" ON "emr_store_requisitions"("organization_id", "number");

CREATE TABLE "emr_store_requisition_lines" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "requisition_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "qty_requested" INTEGER NOT NULL,
  "qty_issued" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "emr_store_requisition_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_store_requisition_lines_requisition_fkey" FOREIGN KEY ("organization_id", "requisition_id") REFERENCES "emr_store_requisitions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_requisition_lines_item_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "emr_store_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_requisition_lines_values_check" CHECK ("qty_requested" > 0 AND "qty_issued" BETWEEN 0 AND "qty_requested")
);
CREATE UNIQUE INDEX "emr_store_requisition_lines_item_key" ON "emr_store_requisition_lines"("organization_id", "requisition_id", "item_id");

CREATE TABLE "emr_store_transfers" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "qty" INTEGER NOT NULL,
  "value_minor" BIGINT NOT NULL,
  "from_location_id" TEXT NOT NULL,
  "to_location_id" TEXT NOT NULL,
  "reference" VARCHAR(80),
  "requisition_id" TEXT,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_store_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_store_transfers_item_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "emr_store_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_transfers_values_check" CHECK ("qty" > 0 AND "value_minor" >= 0 AND "from_location_id" <> "to_location_id")
);

CREATE TABLE "emr_store_counts" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "number" VARCHAR(20) NOT NULL,
  "location_id" TEXT NOT NULL,
  "status" VARCHAR(6) NOT NULL DEFAULT 'DRAFT',
  "note" VARCHAR(500),
  "created_by_user_id" TEXT NOT NULL,
  "posted_by_user_id" TEXT,
  "posted_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_store_counts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_store_counts_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_store_counts_location_fkey" FOREIGN KEY ("organization_id", "location_id") REFERENCES "emr_store_locations"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_counts_values_check" CHECK ("status" IN ('DRAFT', 'POSTED') AND ("status" <> 'POSTED' OR ("posted_by_user_id" IS NOT NULL AND "posted_at" IS NOT NULL)))
);
CREATE UNIQUE INDEX "emr_store_counts_organization_id_number_key" ON "emr_store_counts"("organization_id", "number");

CREATE TABLE "emr_store_count_lines" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "count_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "system_qty" INTEGER NOT NULL,
  "counted_qty" INTEGER,
  CONSTRAINT "emr_store_count_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_store_count_lines_count_fkey" FOREIGN KEY ("organization_id", "count_id") REFERENCES "emr_store_counts"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_count_lines_item_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "emr_store_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_count_lines_values_check" CHECK ("system_qty" >= 0 AND ("counted_qty" IS NULL OR "counted_qty" >= 0))
);
CREATE UNIQUE INDEX "emr_store_count_lines_item_key" ON "emr_store_count_lines"("organization_id", "count_id", "item_id");

CREATE TABLE "emr_store_movements" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "location_id" TEXT NOT NULL,
  "kind" VARCHAR(12) NOT NULL,
  "qty_delta" INTEGER NOT NULL,
  "unit_cost_minor" BIGINT NOT NULL,
  "reference" VARCHAR(80),
  "note" VARCHAR(500),
  "department" VARCHAR(80),
  "purpose" VARCHAR(200),
  "requisition_id" TEXT,
  "transfer_id" TEXT,
  "count_id" TEXT,
  "user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_store_movements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_store_movements_batch_fkey" FOREIGN KEY ("organization_id", "batch_id") REFERENCES "emr_store_batches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_store_movements_values_check" CHECK (
    "kind" IN ('RECEIPT', 'ISSUE', 'ADJUSTMENT', 'WRITE_OFF', 'TRANSFER_OUT', 'TRANSFER_IN', 'COUNT') AND "qty_delta" <> 0
  )
);
CREATE INDEX "emr_store_movements_item_idx" ON "emr_store_movements"("organization_id", "item_id", "created_at");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_store_locations', 'emr_store_items', 'emr_store_batches', 'emr_store_requisitions', 'emr_store_requisition_lines', 'emr_store_transfers', 'emr_store_counts', 'emr_store_count_lines', 'emr_store_movements'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("name", "type", "status", "version") ON "emr_store_locations" TO sabi_emr_app;
GRANT UPDATE ("name", "category", "unit", "min_level", "reorder_level", "reorder_qty", "active", "version", "updated_at") ON "emr_store_items" TO sabi_emr_app;
GRANT UPDATE ("qty_remaining", "status", "quarantine_reason", "quarantined_by_user_id", "quarantined_at") ON "emr_store_batches" TO sabi_emr_app;
GRANT UPDATE ("fulfilling_location_id", "status", "decided_by_user_id", "decided_at", "rejection_reason", "version", "updated_at") ON "emr_store_requisitions" TO sabi_emr_app;
GRANT UPDATE ("qty_issued") ON "emr_store_requisition_lines" TO sabi_emr_app;
GRANT UPDATE ("status", "posted_by_user_id", "posted_at", "version") ON "emr_store_counts" TO sabi_emr_app;
GRANT UPDATE ("counted_qty") ON "emr_store_count_lines" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('stores.read', 'View hospital stores: items, stock by location, requisitions and counts'),
  ('stores.requisition', 'Raise stock requisitions for a ward or department'),
  ('stores.manage', 'Receive, issue, adjust, write off, quarantine and move stock; run stock counts; manage items and locations'),
  ('stores.approve', 'Approve, reject and fulfil stock requisitions')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('INVENTORY_OFFICER', 'stores.read'), ('INVENTORY_OFFICER', 'stores.requisition'), ('INVENTORY_OFFICER', 'stores.manage'), ('INVENTORY_OFFICER', 'stores.approve'),
  ('HOSPITAL_ADMIN', 'stores.read'), ('HOSPITAL_ADMIN', 'stores.approve'),
  ('NURSE', 'stores.read'), ('NURSE', 'stores.requisition'),
  ('LAB_SCIENTIST', 'stores.read'), ('LAB_SCIENTIST', 'stores.requisition'),
  ('PHARMACIST', 'stores.read'), ('PHARMACIST', 'stores.requisition'),
  ('DOCTOR', 'stores.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
