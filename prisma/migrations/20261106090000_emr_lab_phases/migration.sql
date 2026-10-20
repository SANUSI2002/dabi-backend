-- Lab test settings: each test in a hospital's catalog carries its expected turnaround and the bench
-- phases it goes through between specimen collection and result entry (e.g. centrifuge → analysis).
-- Ordered items take a snapshot of both, like the analytes. Each completed phase is logged with who
-- and when (insert-only); results can be entered once every phase before the last is done — entering
-- them completes the last phase.

ALTER TABLE "emr_lab_tests"
  ADD COLUMN "turnaround_minutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "phases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD CONSTRAINT "emr_lab_tests_settings_check" CHECK ("turnaround_minutes" BETWEEN 5 AND 10080 AND cardinality("phases") <= 10);

ALTER TABLE "emr_lab_order_items"
  ADD COLUMN "turnaround_minutes" INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN "phases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "phase_index" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "emr_lab_order_items_phase_check" CHECK ("phase_index" >= 0 AND "phase_index" <= cardinality("phases"));

CREATE TABLE "emr_lab_item_phases" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "phase" VARCHAR(60) NOT NULL,
  "completed_by_user_id" TEXT NOT NULL,
  "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_lab_item_phases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_lab_item_phases_item_fkey" FOREIGN KEY ("organization_id", "item_id") REFERENCES "emr_lab_order_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_lab_item_phases_position_check" CHECK ("position" >= 0)
);
CREATE UNIQUE INDEX "emr_lab_item_phases_item_position_key" ON "emr_lab_item_phases"("organization_id", "item_id", "position");

ALTER TABLE "emr_lab_item_phases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_lab_item_phases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_lab_item_phases_tenant" ON "emr_lab_item_phases" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_lab_item_phases" TO sabi_emr_app;
