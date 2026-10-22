-- Appointment types, transfer reasons, reasons for stopping family planning, store item categories and
-- equipment categories become the organization's own lists (Settings → Master Data; the values used
-- until now are the starter items). The services check each value against the list, so the fixed set
-- the database held for appointment types goes; a type is still a short code.
ALTER TABLE "emr_appointments" DROP CONSTRAINT "emr_appointments_type_check";
ALTER TABLE "emr_appointments" ADD CONSTRAINT "emr_appointments_type_check" CHECK ("type" ~ '^[A-Z][A-Z0-9_]{0,19}$');

-- The stores, equipment and transfer tables kept their lists inside their general value checks: the
-- same checks again, without the lists.
ALTER TABLE "emr_store_items" DROP CONSTRAINT "emr_store_items_values_check";
ALTER TABLE "emr_store_items" ADD CONSTRAINT "emr_store_items_values_check" CHECK (
  length(btrim("category")) > 0 AND
  "reorder_level" >= 0 AND ("min_level" IS NULL OR "min_level" >= 0) AND ("reorder_qty" IS NULL OR "reorder_qty" > 0)
);
ALTER TABLE "emr_assets" DROP CONSTRAINT "emr_assets_values_check";
ALTER TABLE "emr_assets" ADD CONSTRAINT "emr_assets_values_check" CHECK (
  length(btrim("category")) > 0 AND
  "status" IN ('IN_SERVICE', 'UNDER_REPAIR', 'OUT_OF_SERVICE', 'RETIRED') AND
  "service_interval_days" BETWEEN 1 AND 3650 AND ("cost_minor" IS NULL OR "cost_minor" >= 0) AND "last_serviced_on" >= "commissioned_on"
);
ALTER TABLE "emr_patient_transfers" DROP CONSTRAINT "emr_patient_transfers_values_check";
ALTER TABLE "emr_patient_transfers" ADD CONSTRAINT "emr_patient_transfers_values_check" CHECK (
  "direction" IN ('IN', 'OUT') AND "status" IN ('PENDING', 'COMPLETED', 'CANCELLED') AND
  length(btrim("reason")) > 0 AND
  ("direction" <> 'OUT' OR "patient_id" IS NOT NULL) AND
  ("status" <> 'COMPLETED' OR ("completed_by_user_id" IS NOT NULL AND "completed_at" IS NOT NULL)) AND
  ("status" <> 'CANCELLED' OR ("cancelled_by_user_id" IS NOT NULL AND "cancelled_at" IS NOT NULL))
);

-- A list item's name can be up to 120 characters.
ALTER TABLE "emr_store_items" ALTER COLUMN "category" TYPE VARCHAR(120);
ALTER TABLE "emr_assets" ALTER COLUMN "category" TYPE VARCHAR(120);
ALTER TABLE "emr_patient_transfers" ALTER COLUMN "reason" TYPE VARCHAR(120);
ALTER TABLE "emr_fp_clients" ALTER COLUMN "discontinue_reason" TYPE VARCHAR(120);
