-- Forecast scenarios: a month-by-month projection of income and expense accounts (a base figure growing
-- by a monthly rate, with any month set by hand), kept per organization. A removed scenario is kept on
-- record (removed_at) and no longer listed.
CREATE TABLE "acct_forecast_scenarios" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(160) NOT NULL, "basis" VARCHAR(30) NOT NULL,
  "start_period" CHAR(7) NOT NULL, "months" INTEGER NOT NULL, "lines" JSONB NOT NULL DEFAULT '[]',
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removed_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_forecast_scenarios_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_forecast_scenarios_values_check" CHECK (
    "basis" IN ('Last 3 months average', 'Budget', 'Manual base') AND "start_period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND
    "months" BETWEEN 1 AND 36 AND jsonb_typeof("lines") = 'array'
  )
);
CREATE INDEX "acct_forecast_scenarios_organization_id_idx" ON "acct_forecast_scenarios"("organization_id", "created_at");
ALTER TABLE "acct_forecast_scenarios" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_forecast_scenarios" FORCE ROW LEVEL SECURITY;
CREATE POLICY "acct_forecast_scenarios_tenant" ON "acct_forecast_scenarios" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "acct_forecast_scenarios" TO sabi_emr_app;
GRANT UPDATE ("name", "months", "lines", "removed_at", "version") ON "acct_forecast_scenarios" TO sabi_emr_app;
