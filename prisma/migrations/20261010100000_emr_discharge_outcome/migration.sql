-- The discharge outcome as the ward records it (e.g. Recovered, Improved, Absconded). The coded
-- disposition (HOME, TRANSFERRED_OUT, DECEASED, …) stays the field rules and reports rely on.
ALTER TABLE "emr_admissions" ADD COLUMN "discharge_outcome" TEXT;
