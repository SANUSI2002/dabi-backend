-- Accounting, part 5: fixed assets, budgets and tax returns.
-- A fixed asset is the register entry behind the ledger's asset accounts: acquisition, construction in
-- progress, monthly depreciation runs (one per month, posted through the ledger), revaluation or impairment,
-- and disposal. Budgets hold twelve monthly amounts per account (and cost centre); one budget per fiscal year
-- is active. A tax return is prepared from the period's movement on its liability account and remitted
-- through the ledger; filing is recorded with the authority's own acknowledgement (no direct e-filing link).

CREATE TABLE "acct_fixed_assets" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "tag" VARCHAR(20) NOT NULL, "name" VARCHAR(160) NOT NULL, "category" VARCHAR(80) NOT NULL,
  "acquisition_date" TIMESTAMP(3) NOT NULL, "cost" DECIMAL(16,2) NOT NULL DEFAULT 0, "asset_account_number" INTEGER NOT NULL, "method" VARCHAR(16) NOT NULL DEFAULT 'Straight Line',
  "useful_life_months" INTEGER NOT NULL DEFAULT 0, "salvage_value" DECIMAL(16,2) NOT NULL DEFAULT 0, "reducing_rate_annual" DECIMAL(6,2),
  "accumulated_depreciation" DECIMAL(16,2) NOT NULL DEFAULT 0, "status" VARCHAR(18) NOT NULL DEFAULT 'Active', "source_bill_id" TEXT,
  "disposal_date" TIMESTAMP(3), "disposal_proceeds" DECIMAL(16,2), "last_depreciated_period" VARCHAR(7),
  "revaluation_reserve" DECIMAL(16,2) NOT NULL DEFAULT 0, "impairment_loss" DECIMAL(16,2) NOT NULL DEFAULT 0, "cwip_spend" DECIMAL(16,2) NOT NULL DEFAULT 0,
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_fixed_assets_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_fixed_assets_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "acct_fixed_assets_account_fkey" FOREIGN KEY ("organization_id", "asset_account_number") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_fixed_assets_check" CHECK (
    "method" IN ('Straight Line', 'Reducing Balance') AND "status" IN ('Active', 'Fully Depreciated', 'Disposed', 'Under Construction', 'Impaired') AND
    "cost" >= 0 AND "salvage_value" >= 0 AND "accumulated_depreciation" >= 0 AND "useful_life_months" BETWEEN 0 AND 1200 AND ("status" = 'Under Construction' OR "useful_life_months" > 0)
  )
);
CREATE UNIQUE INDEX "acct_fixed_assets_tag_key" ON "acct_fixed_assets"("organization_id", "tag");

CREATE TABLE "acct_depreciation_runs" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "period" VARCHAR(7) NOT NULL, "entries" JSONB NOT NULL, "total" DECIMAL(16,2) NOT NULL,
  "journal_entry_id" TEXT NOT NULL, "run_by_user_id" TEXT NOT NULL, "run_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_depreciation_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_depreciation_runs_entry_fkey" FOREIGN KEY ("organization_id", "journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_depreciation_runs_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND jsonb_typeof("entries") = 'array' AND "total" > 0)
);
-- one run per month
CREATE UNIQUE INDEX "acct_depreciation_runs_period_key" ON "acct_depreciation_runs"("organization_id", "period");

CREATE TABLE "acct_asset_revaluations" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "asset_id" TEXT NOT NULL, "revalued_on" TIMESTAMP(3) NOT NULL, "kind" VARCHAR(11) NOT NULL,
  "carrying_before" DECIMAL(16,2) NOT NULL, "carrying_after" DECIMAL(16,2) NOT NULL, "delta" DECIMAL(16,2) NOT NULL, "note" VARCHAR(500),
  "journal_entry_id" TEXT NOT NULL, "by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_asset_revaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_asset_revaluations_asset_fkey" FOREIGN KEY ("organization_id", "asset_id") REFERENCES "acct_fixed_assets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_asset_revaluations_entry_fkey" FOREIGN KEY ("organization_id", "journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_asset_revaluations_check" CHECK ("kind" IN ('Revaluation', 'Impairment', 'Reversal') AND "delta" <> 0)
);

CREATE TABLE "acct_cost_centres" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "code" VARCHAR(20) NOT NULL, "name" VARCHAR(120) NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_cost_centres_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "acct_cost_centres_code_key" ON "acct_cost_centres"("organization_id", "code");

-- lines: [{ id, accountNumber, costCentreId?, monthly: [12 amounts, Jan..Dec] }]
CREATE TABLE "acct_budgets" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(160) NOT NULL, "fiscal_year" INTEGER NOT NULL, "status" VARCHAR(6) NOT NULL DEFAULT 'Draft',
  "lines" JSONB NOT NULL DEFAULT '[]', "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_budgets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_budgets_check" CHECK ("status" IN ('Draft', 'Active', 'Closed') AND "fiscal_year" BETWEEN 2000 AND 2100 AND jsonb_typeof("lines") = 'array')
);
-- one active budget per fiscal year
CREATE UNIQUE INDEX "acct_budgets_active_key" ON "acct_budgets"("organization_id", "fiscal_year") WHERE "status" = 'Active';

CREATE TABLE "acct_tax_returns" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "reference" VARCHAR(40) NOT NULL, "return_type" VARCHAR(4) NOT NULL, "authority" VARCHAR(10) NOT NULL,
  "liability_account" INTEGER NOT NULL, "period_start" TIMESTAMP(3) NOT NULL, "period_end" TIMESTAMP(3) NOT NULL,
  "output_tax" DECIMAL(16,2) NOT NULL, "input_tax" DECIMAL(16,2) NOT NULL, "net_payable" DECIMAL(16,2) NOT NULL, "status" VARCHAR(6) NOT NULL DEFAULT 'Open',
  "submission_ref" VARCHAR(100), "filed_via" VARCHAR(120), "filed_at" TIMESTAMP(3), "filed_by_user_id" TEXT, "paid_at" TIMESTAMP(3), "journal_entry_id" TEXT,
  "prepared_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_tax_returns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_tax_returns_entry_fkey" FOREIGN KEY ("organization_id", "journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_tax_returns_check" CHECK ("return_type" IN ('VAT', 'WHT', 'PAYE') AND "status" IN ('Open', 'Filed', 'Paid') AND "period_end" >= "period_start")
);
CREATE INDEX "acct_tax_returns_period_idx" ON "acct_tax_returns"("organization_id", "return_type", "period_end");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['acct_fixed_assets', 'acct_depreciation_runs', 'acct_asset_revaluations', 'acct_cost_centres', 'acct_budgets', 'acct_tax_returns'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("tag", "name", "category", "acquisition_date", "cost", "method", "useful_life_months", "salvage_value", "reducing_rate_annual", "accumulated_depreciation", "status",
  "disposal_date", "disposal_proceeds", "last_depreciated_period", "revaluation_reserve", "impairment_loss", "cwip_spend", "version") ON "acct_fixed_assets" TO sabi_emr_app;
GRANT UPDATE ("name", "active", "version") ON "acct_cost_centres" TO sabi_emr_app;
GRANT UPDATE ("name", "status", "lines", "version") ON "acct_budgets" TO sabi_emr_app;
GRANT UPDATE ("status", "submission_ref", "filed_via", "filed_at", "filed_by_user_id", "paid_at", "journal_entry_id", "version") ON "acct_tax_returns" TO sabi_emr_app;
