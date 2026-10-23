-- Accounting, part 4: banking and expense claims. A bank account is a ledger account (subtype bank or cash)
-- with the bank's details beside it. Statement lines come from imported statements; reconciliation rules
-- book recurring bank-only items; a reconciliation clears ledger movements up to a statement date until the
-- cleared balance meets the statement. Live bank feeds need an open-banking provider, which is not
-- configured, so none are stored here. Expense claims follow the organization's approval rules and post
-- through the ledger: the accrual on approval, the settlement when a claimant is reimbursed.

CREATE TABLE "acct_bank_accounts" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "account_number" INTEGER NOT NULL, "bank_name" VARCHAR(120) NOT NULL, "account_name" VARCHAR(160) NOT NULL,
  "account_no" VARCHAR(40) NOT NULL, "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN', "sort_code" VARCHAR(20), "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_bank_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_bank_accounts_account_fkey" FOREIGN KEY ("organization_id", "account_number") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "acct_bank_accounts_number_key" ON "acct_bank_accounts"("organization_id", "account_number");

CREATE TABLE "acct_statement_lines" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "account_number" INTEGER NOT NULL, "line_date" TIMESTAMP(3) NOT NULL, "description" VARCHAR(300) NOT NULL,
  "amount" DECIMAL(16,2) NOT NULL, "reference" VARCHAR(100), "reconciled" BOOLEAN NOT NULL DEFAULT false, "matched_journal_entry_id" TEXT, "rule_applied" TEXT,
  "origin" VARCHAR(6) NOT NULL DEFAULT 'import', "imported_by_user_id" TEXT NOT NULL, "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_statement_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_statement_lines_account_fkey" FOREIGN KEY ("organization_id", "account_number") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_statement_lines_entry_fkey" FOREIGN KEY ("organization_id", "matched_journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_statement_lines_check" CHECK ("amount" <> 0 AND "origin" IN ('import', 'feed'))
);
CREATE INDEX "acct_statement_lines_account_idx" ON "acct_statement_lines"("organization_id", "account_number", "reconciled");

CREATE TABLE "acct_reconciliation_rules" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "account_number" INTEGER NOT NULL, "name" VARCHAR(120) NOT NULL, "description_contains" VARCHAR(120),
  "direction" VARCHAR(3), "contra_account" INTEGER NOT NULL, "memo" VARCHAR(200), "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_reconciliation_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_reconciliation_rules_account_fkey" FOREIGN KEY ("organization_id", "account_number") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_reconciliation_rules_contra_fkey" FOREIGN KEY ("organization_id", "contra_account") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_reconciliation_rules_check" CHECK ("direction" IS NULL OR "direction" IN ('in', 'out'))
);

-- cleared_keys: the ledger movements ("entryId:lineId") ticked off against the statement.
CREATE TABLE "acct_reconciliations" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "account_number" INTEGER NOT NULL, "statement_date" TIMESTAMP(3) NOT NULL,
  "opening_balance" DECIMAL(16,2) NOT NULL, "closing_balance" DECIMAL(16,2) NOT NULL, "status" VARCHAR(12) NOT NULL DEFAULT 'In Progress',
  "cleared_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "started_by_user_id" TEXT NOT NULL, "completed_by_user_id" TEXT, "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_reconciliations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_reconciliations_account_fkey" FOREIGN KEY ("organization_id", "account_number") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_reconciliations_check" CHECK ("status" IN ('In Progress', 'Reconciled'))
);
-- one reconciliation in progress per account at a time
CREATE UNIQUE INDEX "acct_reconciliations_open_key" ON "acct_reconciliations"("organization_id", "account_number") WHERE "status" = 'In Progress';

CREATE TABLE "acct_expense_claims" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "number" VARCHAR(40) NOT NULL, "claimant_employee_id" TEXT, "claim_date" TIMESTAMP(3) NOT NULL,
  "title" VARCHAR(200) NOT NULL, "cost_center" VARCHAR(120), "pay_mode" VARCHAR(20) NOT NULL, "paid_from_account" INTEGER, "lines" JSONB NOT NULL, "receipt_ref" VARCHAR(100),
  "status" VARCHAR(16) NOT NULL DEFAULT 'Draft', "approval" JSONB NOT NULL, "journal_entry_id" TEXT, "payment_journal_entry_id" TEXT, "paid_at" TIMESTAMP(3),
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_expense_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_expense_claims_employee_fkey" FOREIGN KEY ("organization_id", "claimant_employee_id") REFERENCES "wf_employees"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_expense_claims_entry_fkey" FOREIGN KEY ("organization_id", "journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_expense_claims_payment_fkey" FOREIGN KEY ("organization_id", "payment_journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_expense_claims_check" CHECK (
    "pay_mode" IN ('Petty Cash', 'Bank — direct', 'Reimburse to staff') AND "status" IN ('Draft', 'Pending Approval', 'Approved', 'Rejected', 'Paid', 'Discarded') AND jsonb_typeof("lines") = 'array'
  )
);
CREATE UNIQUE INDEX "acct_expense_claims_number_key" ON "acct_expense_claims"("organization_id", "number");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['acct_bank_accounts', 'acct_statement_lines', 'acct_reconciliation_rules', 'acct_reconciliations', 'acct_expense_claims'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("bank_name", "account_name", "account_no", "currency", "sort_code", "active", "version") ON "acct_bank_accounts" TO sabi_emr_app;
GRANT UPDATE ("reconciled", "matched_journal_entry_id", "rule_applied") ON "acct_statement_lines" TO sabi_emr_app;
GRANT UPDATE ("name", "description_contains", "direction", "contra_account", "memo", "active", "version") ON "acct_reconciliation_rules" TO sabi_emr_app;
GRANT UPDATE ("status", "cleared_keys", "completed_by_user_id", "completed_at", "version") ON "acct_reconciliations" TO sabi_emr_app;
GRANT UPDATE ("claimant_employee_id", "claim_date", "title", "cost_center", "pay_mode", "paid_from_account", "lines", "receipt_ref", "status", "approval",
  "journal_entry_id", "payment_journal_entry_id", "paid_at", "version") ON "acct_expense_claims" TO sabi_emr_app;
