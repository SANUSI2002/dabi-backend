-- NCD conditions, outreach activity types and payment receiving accounts become the organization's own
-- lists (Settings → Master Data; the values used until now are the starter items, and the starter NCD
-- conditions keep their names, so NCD reports still count them). The services check each value against
-- the list; the database keeps the rest of each value check and widens the columns to a list item's
-- 120 characters.
ALTER TABLE "emr_ncd_clients" DROP CONSTRAINT "emr_ncd_clients_values_check";
ALTER TABLE "emr_ncd_clients" ADD CONSTRAINT "emr_ncd_clients_values_check" CHECK (
  length(btrim("condition")) > 0 AND
  "control" IN ('CONTROLLED', 'UNCONTROLLED') AND "status" IN ('ACTIVE') AND
  (("systolic" IS NULL) = ("diastolic" IS NULL)) AND ("systolic" IS NULL OR ("systolic" BETWEEN 50 AND 260 AND "diastolic" BETWEEN 30 AND 180 AND "diastolic" < "systolic")) AND
  ("fasting_glucose_mmol" IS NULL OR "fasting_glucose_mmol" BETWEEN 1 AND 40)
);
ALTER TABLE "emr_ncd_clients" ALTER COLUMN "condition" TYPE VARCHAR(120);

ALTER TABLE "emr_outreach_activities" DROP CONSTRAINT "emr_outreach_activities_values_check";
ALTER TABLE "emr_outreach_activities" ADD CONSTRAINT "emr_outreach_activities_values_check" CHECK (
  length(btrim("activity_type")) > 0 AND
  "households" BETWEEN 0 AND 100000 AND "referrals" BETWEEN 0 AND 100000 AND "status" IN ('ACTIVE', 'ENTERED_IN_ERROR') AND
  ("status" <> 'ENTERED_IN_ERROR' OR ("entered_in_error_reason" IS NOT NULL AND "entered_in_error_by_user_id" IS NOT NULL AND "entered_in_error_at" IS NOT NULL))
);
ALTER TABLE "emr_outreach_activities" ALTER COLUMN "activity_type" TYPE VARCHAR(120);

ALTER TABLE "emr_payments" ALTER COLUMN "receiving_account" TYPE VARCHAR(120);
