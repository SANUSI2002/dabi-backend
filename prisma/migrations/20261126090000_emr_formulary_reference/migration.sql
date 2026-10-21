-- Drug reference (EMDEX). Doctors search the national drug index when prescribing; a product they pick
-- that the hospital formulary does not have yet is added to it from the reference record — not stocked
-- (no batches), so the prescription still goes to pharmacy review, which dispenses or sends it out.
-- The reference id is kept, so the same product is never added twice.
ALTER TABLE "emr_formulary_items" ADD COLUMN "reference_source" VARCHAR(10), ADD COLUMN "reference_id" VARCHAR(80), ADD COLUMN "added_by_user_id" TEXT;
ALTER TABLE "emr_formulary_items" ADD CONSTRAINT "emr_formulary_items_reference_check"
  CHECK (("reference_source" IS NULL AND "reference_id" IS NULL) OR ("reference_source" IN ('EMDEX') AND "reference_id" IS NOT NULL));
CREATE UNIQUE INDEX "emr_formulary_items_reference_key" ON "emr_formulary_items"("organization_id", "reference_source", "reference_id") WHERE "reference_id" IS NOT NULL;
