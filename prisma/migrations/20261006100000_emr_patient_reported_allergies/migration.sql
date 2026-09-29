-- Allergies as the patient reports them at the registration desk (free text, unverified).
-- Prescribing safety checks never read this column: a clinician confirms each allergy as a coded
-- record (emr_allergies). Keeping the desk's note stops it from being lost in the meantime.
ALTER TABLE "emr_patients" ADD COLUMN "reported_allergies" TEXT;
