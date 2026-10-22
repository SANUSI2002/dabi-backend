-- Landed costs: freight, duty, clearing and the like added to stock after it was received. Each item's
-- share raises the unit cost of its batches still on hand (so stock valuation and the inventory account
-- stay equal); the share that falls on stock already used, and the odd kobo a per-unit split cannot
-- carry, goes to cost of goods sold. One row per application, with how each item's share was split.

CREATE TABLE "acct_landed_costs" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "cost_date" TIMESTAMP(3) NOT NULL, "description" VARCHAR(300) NOT NULL,
  "credit_account" INTEGER NOT NULL, "total" DECIMAL(16,2) NOT NULL, "allocations" JSONB NOT NULL, "journal_entry_id" TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_landed_costs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_landed_costs_values_check" CHECK ("total" > 0 AND jsonb_typeof("allocations") = 'array')
);
CREATE INDEX "acct_landed_costs_organization_id_cost_date_idx" ON "acct_landed_costs"("organization_id", "cost_date");
ALTER TABLE "acct_landed_costs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_landed_costs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "acct_landed_costs_tenant" ON "acct_landed_costs" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "acct_landed_costs" TO sabi_emr_app;

-- A landed cost raises a batch's unit cost; nothing else changes it.
GRANT UPDATE ("unit_cost_minor") ON "emr_store_batches" TO sabi_emr_app;
