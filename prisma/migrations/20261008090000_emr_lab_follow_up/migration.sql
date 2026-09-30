-- Follow-up on laboratory results, recorded per ordered test:
--   returned:     a verifier sends an unverified result back to the bench, with the reason;
--   acknowledged: the clinician confirms they have seen a released result;
--   communicated: the lab records who it told about an abnormal/critical result, and when.
-- Each is who + when (+ reason / recipient) together or not at all; acknowledgement and
-- communication only exist on released (VERIFIED) tests.

ALTER TABLE "emr_lab_order_items"
  ADD COLUMN "return_reason" TEXT,
  ADD COLUMN "returned_at" TIMESTAMP(3),
  ADD COLUMN "returned_by_user_id" TEXT,
  ADD COLUMN "acknowledged_at" TIMESTAMP(3),
  ADD COLUMN "acknowledged_by_user_id" TEXT,
  ADD COLUMN "critical_communicated_at" TIMESTAMP(3),
  ADD COLUMN "critical_communicated_by_user_id" TEXT,
  ADD COLUMN "critical_communicated_to_user_id" TEXT;

ALTER TABLE "emr_lab_order_items" ADD CONSTRAINT "emr_lab_order_items_returned_check"
  CHECK (("returned_at" IS NULL) = ("returned_by_user_id" IS NULL) AND ("returned_at" IS NULL) = ("return_reason" IS NULL)) NOT VALID;
ALTER TABLE "emr_lab_order_items" VALIDATE CONSTRAINT "emr_lab_order_items_returned_check";
ALTER TABLE "emr_lab_order_items" ADD CONSTRAINT "emr_lab_order_items_acknowledged_check"
  CHECK (("acknowledged_at" IS NULL) = ("acknowledged_by_user_id" IS NULL) AND ("acknowledged_at" IS NULL OR "status" = 'VERIFIED')) NOT VALID;
ALTER TABLE "emr_lab_order_items" VALIDATE CONSTRAINT "emr_lab_order_items_acknowledged_check";
ALTER TABLE "emr_lab_order_items" ADD CONSTRAINT "emr_lab_order_items_communicated_check"
  CHECK (("critical_communicated_at" IS NULL) = ("critical_communicated_by_user_id" IS NULL)
    AND ("critical_communicated_at" IS NULL) = ("critical_communicated_to_user_id" IS NULL)
    AND ("critical_communicated_at" IS NULL OR "status" = 'VERIFIED')) NOT VALID;
ALTER TABLE "emr_lab_order_items" VALIDATE CONSTRAINT "emr_lab_order_items_communicated_check";
