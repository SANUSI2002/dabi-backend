-- Healthcare payers and credit risk:
--   payer transfers — a patient's charges billed to their HMO or NHIA (Dr payer receivable, Cr patient
--     receivable), with the authorization code and enrollee number;
--   payer claims — a batch of the payer's invoices submitted for a period, then adjudicated: what the
--     payer approved, and for each denial whether it was written off (Claim Denials) or billed back to the
--     patient;
--   capitation — a payer's fixed payment per enrollee for months of cover, recognized month by month
--     (Deferred Revenue until the month starts);
--   write-offs of uncollectable invoices (against the Allowance for Doubtful Debts, the rest to Bad Debt
--     Expense) and later recoveries; and
--   credit-loss runs — the allowance re-measured from a provision matrix (expected loss rate by days past
--     due, for patients and for payers), the adjustment posted to Bad Debt Expense.
CREATE TABLE "acct_payer_transfers" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL,
  "patient_invoice_id" TEXT NOT NULL, "payer_invoice_id" TEXT NOT NULL, "patient_customer_id" TEXT NOT NULL, "payer_customer_id" TEXT NOT NULL,
  "amount" DECIMAL(16,2) NOT NULL, "rebilled_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
  "authorization_code" VARCHAR(60), "enrollee_number" VARCHAR(60),
  "journal_entry_id" TEXT NOT NULL, "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversed_at" TIMESTAMP(3),
  CONSTRAINT "acct_payer_transfers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_payer_transfers_check" CHECK ("amount" > 0 AND "rebilled_amount" >= 0 AND "rebilled_amount" <= "amount" AND "patient_customer_id" <> "payer_customer_id")
);
CREATE INDEX "acct_payer_transfers_patient_idx" ON "acct_payer_transfers"("organization_id", "patient_invoice_id");
CREATE UNIQUE INDEX "acct_payer_transfers_payer_invoice_key" ON "acct_payer_transfers"("organization_id", "payer_invoice_id");

CREATE TABLE "acct_payer_claims" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "number" VARCHAR(40) NOT NULL, "payer_customer_id" TEXT NOT NULL,
  "period_start" DATE NOT NULL, "period_end" DATE NOT NULL, "status" VARCHAR(11) NOT NULL DEFAULT 'Draft',
  "items" JSONB NOT NULL, "reference" VARCHAR(100), "notes" VARCHAR(2000),
  "submitted_at" TIMESTAMP(3), "submitted_by_user_id" TEXT, "adjudicated_at" TIMESTAMP(3), "adjudicated_by_user_id" TEXT,
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_payer_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_payer_claims_check" CHECK (
    "status" IN ('Draft', 'Submitted', 'Adjudicated', 'Cancelled') AND jsonb_typeof("items") = 'array' AND "period_end" >= "period_start"
    AND (("status" IN ('Submitted', 'Adjudicated')) = ("submitted_at" IS NOT NULL)) AND (("status" = 'Adjudicated') = ("adjudicated_at" IS NOT NULL)))
);
CREATE UNIQUE INDEX "acct_payer_claims_number_key" ON "acct_payer_claims"("organization_id", "number");
CREATE INDEX "acct_payer_claims_payer_idx" ON "acct_payer_claims"("organization_id", "payer_customer_id");

CREATE TABLE "acct_capitations" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "number" VARCHAR(40) NOT NULL, "payer_customer_id" TEXT NOT NULL,
  "start_period" CHAR(7) NOT NULL, "months" INTEGER NOT NULL, "enrollees" INTEGER NOT NULL, "rate_per_enrollee" DECIMAL(16,2) NOT NULL, "amount" DECIMAL(16,2) NOT NULL,
  "received_date" DATE NOT NULL, "deposit_account_number" INTEGER NOT NULL, "reference" VARCHAR(100), "entries" JSONB NOT NULL,
  "journal_entry_id" TEXT NOT NULL, "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_capitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_capitations_check" CHECK ("start_period" ~ '^\d{4}-(0[1-9]|1[0-2])$' AND "months" BETWEEN 1 AND 24 AND "enrollees" > 0 AND "rate_per_enrollee" > 0 AND "amount" > 0 AND jsonb_typeof("entries") = 'array')
);
CREATE UNIQUE INDEX "acct_capitations_number_key" ON "acct_capitations"("organization_id", "number");

CREATE TABLE "acct_write_offs" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "invoice_id" TEXT NOT NULL, "customer_id" TEXT NOT NULL,
  "amount" DECIMAL(16,2) NOT NULL, "from_allowance" DECIMAL(16,2) NOT NULL, "reason" VARCHAR(500) NOT NULL, "recovered_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
  "journal_entry_id" TEXT NOT NULL, "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_write_offs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_write_offs_check" CHECK ("amount" > 0 AND "from_allowance" >= 0 AND "from_allowance" <= "amount" AND "recovered_amount" >= 0 AND "recovered_amount" <= "amount")
);
CREATE INDEX "acct_write_offs_invoice_idx" ON "acct_write_offs"("organization_id", "invoice_id");

CREATE TABLE "acct_credit_loss_runs" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "as_of" DATE NOT NULL, "rates" JSONB NOT NULL, "buckets" JSONB NOT NULL,
  "required" DECIMAL(16,2) NOT NULL, "previous" DECIMAL(16,2) NOT NULL, "adjustment" DECIMAL(16,2) NOT NULL,
  "journal_entry_id" TEXT, "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_credit_loss_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_credit_loss_runs_check" CHECK ("required" >= 0 AND jsonb_typeof("rates") = 'object' AND jsonb_typeof("buckets") = 'array' AND (("adjustment" = 0) = ("journal_entry_id" IS NULL)))
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['acct_payer_transfers', 'acct_payer_claims', 'acct_capitations', 'acct_write_offs', 'acct_credit_loss_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("rebilled_amount", "reversed_at") ON "acct_payer_transfers" TO sabi_emr_app;
GRANT UPDATE ("status", "items", "reference", "notes", "period_start", "period_end", "submitted_at", "submitted_by_user_id", "adjudicated_at", "adjudicated_by_user_id", "version") ON "acct_payer_claims" TO sabi_emr_app;
GRANT UPDATE ("entries", "version") ON "acct_capitations" TO sabi_emr_app;
GRANT UPDATE ("recovered_amount", "version") ON "acct_write_offs" TO sabi_emr_app;

-- the journal sources these post under
ALTER TABLE "acct_journal_entries" DROP CONSTRAINT "acct_journal_entries_values_check";
ALTER TABLE "acct_journal_entries" ADD CONSTRAINT "acct_journal_entries_values_check" CHECK (
  "status" IN ('Draft', 'Pending Approval', 'Posted', 'Reversed', 'Void') AND
  "source" IN ('Manual', 'Opening Balance', 'Invoice', 'Customer Payment', 'Credit Note', 'Sales Receipt', 'Refund Receipt', 'Bill', 'Vendor Payment',
    'Vendor Credit', 'Expense', 'Bank Transaction', 'Depreciation', 'Payroll', 'Inventory', 'Tax', 'Reversal', 'FX Revaluation', 'Year-End Close',
    'Payer Transfer', 'Claim Adjudication', 'Capitation', 'Write-off', 'Recovery', 'Credit Loss') AND
  ("status" NOT IN ('Posted', 'Reversed') OR ("posted_by_user_id" IS NOT NULL AND "posted_at" IS NOT NULL)) AND
  (("status" = 'Reversed') = ("reversed_by_entry_id" IS NOT NULL))
);
