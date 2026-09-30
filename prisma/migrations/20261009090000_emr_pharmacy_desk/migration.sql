-- What the pharmacy desk records beyond dispensing:
--   prescription lines the pharmacy closes without dispensing — sent out to be bought elsewhere
--   (OUTSOURCED) or not dispensed at all (NOT_DISPENSED) — with the reason, who and when;
--   catalogue details kept with each formulary product (category, manufacturer, whether a
--   prescription is required, minimum stock, patient-facing and internal notes).

ALTER TABLE "emr_prescription_items"
  ADD COLUMN "close_outcome" TEXT,
  ADD COLUMN "close_reason" TEXT,
  ADD COLUMN "closed_by_user_id" TEXT,
  ADD COLUMN "closed_at" TIMESTAMP(3);
ALTER TABLE "emr_prescription_items" ADD CONSTRAINT "emr_prescription_items_close_check"
  CHECK (
    ("close_outcome" IS NULL AND "close_reason" IS NULL AND "closed_by_user_id" IS NULL AND "closed_at" IS NULL)
    OR ("close_outcome" IN ('OUTSOURCED', 'NOT_DISPENSED') AND "close_reason" IS NOT NULL
        AND "closed_by_user_id" IS NOT NULL AND "closed_at" IS NOT NULL AND "status" = 'CANCELLED')
  ) NOT VALID;
ALTER TABLE "emr_prescription_items" VALIDATE CONSTRAINT "emr_prescription_items_close_check";

ALTER TABLE "emr_formulary_items"
  ADD COLUMN "category" TEXT,
  ADD COLUMN "manufacturer" TEXT,
  ADD COLUMN "prescription_required" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "min_stock" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "patient_description" TEXT,
  ADD COLUMN "pharmacist_notes" TEXT;
ALTER TABLE "emr_formulary_items" ADD CONSTRAINT "emr_formulary_items_min_stock_check" CHECK ("min_stock" >= 0) NOT VALID;
ALTER TABLE "emr_formulary_items" VALIDATE CONSTRAINT "emr_formulary_items_min_stock_check";
