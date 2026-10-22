-- Equipment intelligence (SCADA), part 2: looking after the equipment — maintenance work orders,
-- calibrations, consumables, warranty and claims, and usage sessions.
--
--   a work order completes only with a passed return-to-service test, and then resolves the
--   equipment's open maintenance alarm; a passed calibration resolves its calibration alarm;
--   overdue maintenance or calibration raises one alarm per cause (server-side, never duplicated);
--   a device's TEST_STARTED event uses one unit of a usable consumable and opens a usage session
--   (TEST_COMPLETED closes it); low, expired or exhausted consumables raise one alarm each.

CREATE TABLE "emr_scada_work_orders" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "number" VARCHAR(30) NOT NULL, "type" VARCHAR(10) NOT NULL, "status" VARCHAR(14) NOT NULL DEFAULT 'Requested',
  "severity" VARCHAR(8) NOT NULL, "description" VARCHAR(2000) NOT NULL, "failure_category" VARCHAR(80), "scheduled_for" TIMESTAMP(3), "technician" VARCHAR(160),
  "checklist" JSONB NOT NULL DEFAULT '[]', "parts_used" JSONB NOT NULL DEFAULT '[]', "diagnosis" VARCHAR(2000), "corrective_action" VARCHAR(2000), "labor_cost" DECIMAL(14,2),
  "started_at" TIMESTAMP(3), "completed_at" TIMESTAMP(3), "downtime_minutes" INTEGER, "return_to_service_tested" BOOLEAN NOT NULL DEFAULT false, "return_to_service_note" VARCHAR(1000),
  "cancel_reason" VARCHAR(500), "reported_by_user_id" TEXT NOT NULL, "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "emr_scada_work_orders_pkey" PRIMARY KEY ("id"), CONSTRAINT "emr_scada_work_orders_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_scada_work_orders_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_work_orders_check" CHECK (
    "type" IN ('Preventive', 'Corrective', 'Emergency') AND "severity" IN ('Low', 'Medium', 'High', 'Critical') AND
    "status" IN ('Requested', 'Scheduled', 'In Progress', 'Awaiting Parts', 'Testing', 'Completed', 'Cancelled') AND
    ("status" <> 'Completed' OR ("return_to_service_tested" AND "completed_at" IS NOT NULL)) AND jsonb_typeof("checklist") = 'array' AND jsonb_typeof("parts_used") = 'array'
  )
);
CREATE UNIQUE INDEX "emr_scada_work_orders_number_key" ON "emr_scada_work_orders"("organization_id", "number");

CREATE TABLE "emr_scada_calibrations" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "status" VARCHAR(11) NOT NULL DEFAULT 'Scheduled', "scheduled_for" TIMESTAMP(3) NOT NULL,
  "technician" VARCHAR(160), "vendor" VARCHAR(160), "standards_used" VARCHAR(500), "performed_at" TIMESTAMP(3), "result" VARCHAR(4), "certificate_number" VARCHAR(80),
  "certificate_expiry" TIMESTAMP(3), "notes" VARCHAR(2000), "cancel_reason" VARCHAR(500), "requested_by_user_id" TEXT NOT NULL, "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "emr_scada_calibrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_scada_calibrations_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_calibrations_check" CHECK (
    "status" IN ('Scheduled', 'In Progress', 'Completed', 'Cancelled') AND ("result" IS NULL OR "result" IN ('Pass', 'Fail')) AND
    ("status" <> 'Completed' OR ("result" IS NOT NULL AND "performed_at" IS NOT NULL)) AND ("result" IS DISTINCT FROM 'Pass' OR "certificate_number" IS NOT NULL)
  )
);

CREATE TABLE "emr_scada_consumables" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "name" VARCHAR(160) NOT NULL, "lot_number" VARCHAR(80) NOT NULL, "expiry_date" DATE NOT NULL,
  "unit" VARCHAR(30) NOT NULL, "quantity_on_hand" INTEGER NOT NULL, "reorder_threshold" INTEGER NOT NULL DEFAULT 0, "cost_per_unit" DECIMAL(14,2) NOT NULL DEFAULT 0, "supplier" VARCHAR(160),
  "registered_by_user_id" TEXT NOT NULL, "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "emr_scada_consumables_pkey" PRIMARY KEY ("id"), CONSTRAINT "emr_scada_consumables_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_scada_consumables_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_consumables_check" CHECK ("quantity_on_hand" >= 0 AND "reorder_threshold" >= 0 AND "cost_per_unit" >= 0)
);

CREATE TABLE "emr_scada_consumable_usage" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "consumable_id" TEXT NOT NULL, "quantity_used" INTEGER NOT NULL, "reason" VARCHAR(22) NOT NULL,
  "source" VARCHAR(14) NOT NULL, "test_name" VARCHAR(160), "order_id" TEXT, "by_user_id" TEXT, "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_scada_consumable_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_scada_consumable_usage_item_fkey" FOREIGN KEY ("organization_id", "consumable_id") REFERENCES "emr_scada_consumables"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_consumable_usage_check" CHECK ("quantity_used" > 0 AND "reason" IN ('Test', 'Wastage', 'Expired — discarded') AND "source" IN ('DEVICE_GATEWAY', 'USER'))
);

CREATE TABLE "emr_scada_warranties" (
  "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "provider" VARCHAR(160) NOT NULL, "start" DATE NOT NULL, "end" DATE NOT NULL, "coverage" VARCHAR(1000) NOT NULL,
  "contact_name" VARCHAR(120), "contact_phone" VARCHAR(30), "sla_hours" INTEGER, "updated_by_user_id" TEXT NOT NULL, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_scada_warranties_pkey" PRIMARY KEY ("organization_id", "equipment_id"),
  CONSTRAINT "emr_scada_warranties_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_warranties_check" CHECK ("end" >= "start" AND ("sla_hours" IS NULL OR "sla_hours" > 0))
);

CREATE TABLE "emr_scada_warranty_claims" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "claim_number" VARCHAR(80), "issue" VARCHAR(2000) NOT NULL, "status" VARCHAR(10) NOT NULL DEFAULT 'Submitted',
  "related_work_order_id" TEXT, "repaired_under_warranty" BOOLEAN, "cost_recovered" DECIMAL(14,2), "resolution_note" VARCHAR(2000), "resolved_at" TIMESTAMP(3),
  "raised_by_user_id" TEXT NOT NULL, "raised_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "emr_scada_warranty_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_scada_warranty_claims_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_warranty_claims_wo_fkey" FOREIGN KEY ("organization_id", "related_work_order_id") REFERENCES "emr_scada_work_orders"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_warranty_claims_check" CHECK ("status" IN ('Submitted', 'Approved', 'In Repair', 'Rejected', 'Completed'))
);

CREATE TABLE "emr_scada_usage_sessions" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "equipment_id" TEXT NOT NULL, "operator" VARCHAR(160) NOT NULL, "patient_id" TEXT, "test_name" VARCHAR(160), "order_id" TEXT,
  "correlation_id" VARCHAR(80) NOT NULL, "started_at" TIMESTAMP(3) NOT NULL, "ended_at" TIMESTAMP(3), "outcome" VARCHAR(9),
  CONSTRAINT "emr_scada_usage_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_scada_usage_sessions_equipment_fkey" FOREIGN KEY ("organization_id", "equipment_id") REFERENCES "emr_scada_equipment"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_scada_usage_sessions_check" CHECK ("outcome" IS NULL OR "outcome" IN ('Completed', 'Aborted'))
);
CREATE UNIQUE INDEX "emr_scada_usage_sessions_correlation_key" ON "emr_scada_usage_sessions"("organization_id", "equipment_id", "correlation_id");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_scada_work_orders', 'emr_scada_calibrations', 'emr_scada_consumables', 'emr_scada_consumable_usage', 'emr_scada_warranties', 'emr_scada_warranty_claims', 'emr_scada_usage_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("status", "severity", "description", "failure_category", "scheduled_for", "technician", "checklist", "parts_used", "diagnosis", "corrective_action", "labor_cost",
  "started_at", "completed_at", "downtime_minutes", "return_to_service_tested", "return_to_service_note", "cancel_reason", "version") ON "emr_scada_work_orders" TO sabi_emr_app;
GRANT UPDATE ("status", "scheduled_for", "technician", "vendor", "standards_used", "performed_at", "result", "certificate_number", "certificate_expiry", "notes", "cancel_reason", "version")
  ON "emr_scada_calibrations" TO sabi_emr_app;
GRANT UPDATE ("name", "lot_number", "expiry_date", "unit", "quantity_on_hand", "reorder_threshold", "cost_per_unit", "supplier", "version") ON "emr_scada_consumables" TO sabi_emr_app;
GRANT UPDATE ("provider", "start", "end", "coverage", "contact_name", "contact_phone", "sla_hours", "updated_by_user_id", "updated_at") ON "emr_scada_warranties" TO sabi_emr_app;
GRANT UPDATE ("claim_number", "status", "related_work_order_id", "repaired_under_warranty", "cost_recovered", "resolution_note", "resolved_at", "version") ON "emr_scada_warranty_claims" TO sabi_emr_app;
GRANT UPDATE ("ended_at", "outcome") ON "emr_scada_usage_sessions" TO sabi_emr_app;
