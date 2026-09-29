-- Mid-upper arm circumference (MUAC, cm): the nutrition screen captured at the Vitals station.
-- Swap the code whitelist; NOT VALID then VALIDATE keeps the table readable while existing rows are checked.
ALTER TABLE "emr_observations" DROP CONSTRAINT "emr_observations_code_check";
ALTER TABLE "emr_observations" ADD CONSTRAINT "emr_observations_code_check"
  CHECK ("code" IN ('BP_SYSTOLIC', 'BP_DIASTOLIC', 'HEART_RATE', 'RESPIRATORY_RATE', 'TEMPERATURE', 'SPO2', 'WEIGHT', 'HEIGHT', 'BLOOD_GLUCOSE', 'PAIN_SCORE', 'MUAC')) NOT VALID;
ALTER TABLE "emr_observations" VALIDATE CONSTRAINT "emr_observations_code_check";
