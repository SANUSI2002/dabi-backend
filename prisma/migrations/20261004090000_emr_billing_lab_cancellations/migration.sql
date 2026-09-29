-- A lab test cancelled after it was charged is offset by LAB_CANCELLED adjustment charges, which
-- may be negative (a credit) or positive (re-charging when the original invoice was voided after
-- the credit was invoiced). Extend the two charge constraints accordingly.
--
-- Constraints are re-added NOT VALID and then validated separately: validation takes only a
-- SHARE UPDATE EXCLUSIVE lock, so charges can keep being written while existing rows are checked.

ALTER TABLE "emr_charges" DROP CONSTRAINT "emr_charges_source_check";
ALTER TABLE "emr_charges" ADD CONSTRAINT "emr_charges_source_check"
  CHECK ("source_type" IN ('ENCOUNTER', 'LAB_ORDER_ITEM', 'LAB_CANCELLED', 'DISPENSE_LINE', 'DISPENSE_RETURN', 'BED_DAY', 'MANUAL')) NOT VALID;
ALTER TABLE "emr_charges" VALIDATE CONSTRAINT "emr_charges_source_check";

ALTER TABLE "emr_charges" DROP CONSTRAINT "emr_charges_credit_check";
ALTER TABLE "emr_charges" ADD CONSTRAINT "emr_charges_credit_check"
  CHECK ("quantity" > 0 OR "source_type" IN ('DISPENSE_RETURN', 'LAB_CANCELLED')) NOT VALID;
ALTER TABLE "emr_charges" VALIDATE CONSTRAINT "emr_charges_credit_check";
