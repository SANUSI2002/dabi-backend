-- Accounting, part 1: the general ledger. Chart of accounts, branches (operating entities) and
-- consolidation groups, fiscal years with monthly periods and a books-locked-before date, journal entries
-- with their lines, recurring journals, year-end closings and approval rules. Balances are never stored:
-- they are the sum of posted lines. The database itself refuses an unbalanced posted entry and any change
-- to a posted entry's lines; a posted entry is corrected only by a reversing entry.

CREATE TABLE "acct_accounts" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "number" INTEGER NOT NULL, "name" VARCHAR(120) NOT NULL, "type" VARCHAR(9) NOT NULL,
  "subtype" VARCHAR(24) NOT NULL, "parent_number" INTEGER, "description" VARCHAR(500), "is_active" BOOLEAN NOT NULL DEFAULT true,
  "allow_manual_entry" BOOLEAN NOT NULL DEFAULT true, "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN', "system" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_accounts_values_check" CHECK (
    "number" BETWEEN 1000 AND 5999 AND "type" IN ('asset', 'liability', 'equity', 'revenue', 'expense', 'cogs') AND
    "subtype" IN ('cash', 'bank', 'accounts_receivable', 'inventory', 'current_asset', 'fixed_asset', 'contra_asset', 'other_asset', 'accounts_payable',
      'tax_payable', 'current_liability', 'long_term_liability', 'equity', 'retained_earnings', 'operating_revenue', 'other_income', 'contra_revenue',
      'cost_of_goods_sold', 'operating_expense', 'payroll_expense', 'depreciation_expense', 'other_expense') AND "currency" ~ '^[A-Z]{3}$'
  )
);
CREATE UNIQUE INDEX "acct_accounts_number_key" ON "acct_accounts"("organization_id", "number");

CREATE TABLE "acct_branches" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "code" VARCHAR(12) NOT NULL, "name" VARCHAR(160) NOT NULL, "is_head_office" BOOLEAN NOT NULL DEFAULT false,
  "base_currency" VARCHAR(3) NOT NULL DEFAULT 'NGN', "active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_branches_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_branches_org_id_key" UNIQUE ("organization_id", "id")
);
CREATE UNIQUE INDEX "acct_branches_code_key" ON "acct_branches"("organization_id", "code");
CREATE UNIQUE INDEX "acct_branches_one_head_office" ON "acct_branches"("organization_id") WHERE "is_head_office";

CREATE TABLE "acct_consolidation_groups" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(120) NOT NULL, "branch_ids" TEXT[] NOT NULL, "eliminate" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_consolidation_groups_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_consolidation_groups_check" CHECK (cardinality("branch_ids") >= 1 AND jsonb_typeof("eliminate") = 'array')
);

CREATE TABLE "acct_fiscal_years" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "year" INTEGER NOT NULL, "status" VARCHAR(6) NOT NULL DEFAULT 'Open',
  CONSTRAINT "acct_fiscal_years_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_fiscal_years_check" CHECK ("year" BETWEEN 2000 AND 2200 AND "status" IN ('Open', 'Closed'))
);
CREATE UNIQUE INDEX "acct_fiscal_years_year_key" ON "acct_fiscal_years"("organization_id", "year");
CREATE TABLE "acct_periods" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "fiscal_year" INTEGER NOT NULL, "month" INTEGER NOT NULL, "status" VARCHAR(6) NOT NULL DEFAULT 'Open',
  CONSTRAINT "acct_periods_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_periods_check" CHECK ("month" BETWEEN 1 AND 12 AND "status" IN ('Open', 'Closed', 'Locked'))
);
CREATE UNIQUE INDEX "acct_periods_month_key" ON "acct_periods"("organization_id", "fiscal_year", "month");

-- Ledger-wide settings: the books-locked-before date and the exchange rates used to book foreign amounts.
CREATE TABLE "acct_ledger_settings" (
  "organization_id" TEXT NOT NULL, "books_locked_before" TIMESTAMP(3), "fx_rates" JSONB NOT NULL DEFAULT '[]', "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" TEXT, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_ledger_settings_pkey" PRIMARY KEY ("organization_id"), CONSTRAINT "acct_ledger_settings_check" CHECK (jsonb_typeof("fx_rates") = 'array')
);

CREATE TABLE "acct_journal_entries" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "number" VARCHAR(30) NOT NULL, "entry_date" TIMESTAMP(3) NOT NULL, "branch_id" TEXT NOT NULL,
  "source" VARCHAR(20) NOT NULL, "reference" VARCHAR(100), "memo" VARCHAR(500) NOT NULL, "status" VARCHAR(16) NOT NULL,
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "posted_by_user_id" TEXT, "posted_at" TIMESTAMP(3),
  "reversed_by_entry_id" TEXT, "reverses_entry_id" TEXT, "approval_ref" VARCHAR(100), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_journal_entries_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_journal_entries_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "acct_journal_entries_branch_fkey" FOREIGN KEY ("organization_id", "branch_id") REFERENCES "acct_branches"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_journal_entries_values_check" CHECK (
    "status" IN ('Draft', 'Pending Approval', 'Posted', 'Reversed', 'Void') AND
    "source" IN ('Manual', 'Opening Balance', 'Invoice', 'Customer Payment', 'Credit Note', 'Sales Receipt', 'Refund Receipt', 'Bill', 'Vendor Payment',
      'Vendor Credit', 'Expense', 'Bank Transaction', 'Depreciation', 'Payroll', 'Inventory', 'Tax', 'Reversal', 'FX Revaluation', 'Year-End Close') AND
    ("status" NOT IN ('Posted', 'Reversed') OR ("posted_by_user_id" IS NOT NULL AND "posted_at" IS NOT NULL)) AND
    (("status" = 'Reversed') = ("reversed_by_entry_id" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "acct_journal_entries_number_key" ON "acct_journal_entries"("organization_id", "number");
CREATE UNIQUE INDEX "acct_journal_entries_one_reversal" ON "acct_journal_entries"("organization_id", "reverses_entry_id") WHERE "reverses_entry_id" IS NOT NULL;
CREATE INDEX "acct_journal_entries_date_idx" ON "acct_journal_entries"("organization_id", "entry_date");

CREATE TABLE "acct_journal_lines" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "entry_id" TEXT NOT NULL, "line_no" INTEGER NOT NULL, "account_number" INTEGER NOT NULL,
  "debit" DECIMAL(16,2) NOT NULL DEFAULT 0, "credit" DECIMAL(16,2) NOT NULL DEFAULT 0, "description" VARCHAR(300),
  "cost_center" VARCHAR(60), "customer_id" TEXT, "vendor_id" TEXT, "project_id" TEXT,
  CONSTRAINT "acct_journal_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_journal_lines_entry_fkey" FOREIGN KEY ("organization_id", "entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_journal_lines_account_fkey" FOREIGN KEY ("organization_id", "account_number") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_journal_lines_amount_check" CHECK ("debit" >= 0 AND "credit" >= 0 AND ("debit" = 0) <> ("credit" = 0))
);
CREATE INDEX "acct_journal_lines_entry_idx" ON "acct_journal_lines"("organization_id", "entry_id");
CREATE INDEX "acct_journal_lines_account_idx" ON "acct_journal_lines"("organization_id", "account_number");

-- An entry that is (or becomes) posted must balance and have at least two lines; checked at commit,
-- once all its lines are written.
CREATE FUNCTION "acct_check_entry_balanced"() RETURNS trigger AS $$
DECLARE d NUMERIC; c NUMERIC; n INTEGER;
BEGIN
  IF NEW."status" IN ('Posted', 'Reversed') THEN
    SELECT COALESCE(SUM("debit"), 0), COALESCE(SUM("credit"), 0), COUNT(*) INTO d, c, n FROM "acct_journal_lines" WHERE "organization_id" = NEW."organization_id" AND "entry_id" = NEW."id";
    IF n < 2 OR d <> c OR d = 0 THEN
      RAISE EXCEPTION 'Journal entry % is not balanced', NEW."number" USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "acct_journal_entries_balanced" AFTER INSERT OR UPDATE ON "acct_journal_entries"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "acct_check_entry_balanced"();

-- Lines belong to a draft until it is posted; after that they are history.
CREATE FUNCTION "acct_lines_frozen"() RETURNS trigger AS $$
DECLARE s TEXT;
BEGIN
  SELECT "status" INTO s FROM "acct_journal_entries" WHERE "organization_id" = COALESCE(OLD."organization_id", NEW."organization_id") AND "id" = COALESCE(OLD."entry_id", NEW."entry_id");
  IF s IN ('Posted', 'Reversed', 'Void') THEN
    RAISE EXCEPTION 'Lines of a % journal entry cannot change', lower(s) USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "acct_journal_lines_frozen" BEFORE INSERT OR UPDATE OR DELETE ON "acct_journal_lines" FOR EACH ROW EXECUTE FUNCTION "acct_lines_frozen"();

CREATE TABLE "acct_recurring_journals" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "memo" VARCHAR(500) NOT NULL, "lines" JSONB NOT NULL, "every_months" INTEGER NOT NULL,
  "next_date" TIMESTAMP(3) NOT NULL, "end_date" TIMESTAMP(3), "last_posted_date" TIMESTAMP(3), "posted_count" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true, "branch_id" TEXT NOT NULL, "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_recurring_journals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_recurring_journals_check" CHECK ("every_months" BETWEEN 1 AND 24 AND jsonb_typeof("lines") = 'array')
);

CREATE TABLE "acct_year_end_closings" (
  "organization_id" TEXT NOT NULL, "year" INTEGER NOT NULL, "closed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "closed_by_user_id" TEXT NOT NULL,
  "net_income" DECIMAL(16,2) NOT NULL, "journal_entry_id" TEXT NOT NULL,
  CONSTRAINT "acct_year_end_closings_pkey" PRIMARY KEY ("organization_id", "year")
);

CREATE TABLE "acct_approval_rules" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "doc_type" VARCHAR(24) NOT NULL, "min_amount" DECIMAL(16,2) NOT NULL, "max_amount" DECIMAL(16,2),
  "approver_role" VARCHAR(20) NOT NULL, "level" INTEGER NOT NULL, "active" BOOLEAN NOT NULL DEFAULT true, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_approval_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_approval_rules_check" CHECK (
    "doc_type" IN ('Purchase Requisition', 'Purchase Order', 'Bill', 'Vendor Payment', 'Expense Claim', 'Journal Entry') AND
    "approver_role" IN ('Accountant', 'Approver', 'Finance Controller') AND "level" BETWEEN 1 AND 9 AND "min_amount" >= 0 AND ("max_amount" IS NULL OR "max_amount" > "min_amount")
  )
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['acct_accounts', 'acct_branches', 'acct_consolidation_groups', 'acct_fiscal_years', 'acct_periods', 'acct_ledger_settings',
    'acct_journal_entries', 'acct_journal_lines', 'acct_recurring_journals', 'acct_year_end_closings', 'acct_approval_rules'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("name", "subtype", "parent_number", "description", "is_active", "allow_manual_entry", "version") ON "acct_accounts" TO sabi_emr_app;
GRANT UPDATE ("name", "active") ON "acct_branches" TO sabi_emr_app;
GRANT UPDATE ("status") ON "acct_fiscal_years", "acct_periods" TO sabi_emr_app;
GRANT UPDATE ("books_locked_before", "fx_rates", "version", "updated_by_user_id", "updated_at") ON "acct_ledger_settings" TO sabi_emr_app;
GRANT UPDATE ("entry_date", "memo", "reference", "status", "posted_by_user_id", "posted_at", "reversed_by_entry_id", "version") ON "acct_journal_entries" TO sabi_emr_app;
GRANT DELETE ON "acct_journal_lines" TO sabi_emr_app;
GRANT UPDATE ("memo", "every_months", "next_date", "end_date", "last_posted_date", "posted_count", "active", "version") ON "acct_recurring_journals" TO sabi_emr_app;
GRANT UPDATE ("min_amount", "max_amount", "approver_role", "level", "active", "version") ON "acct_approval_rules" TO sabi_emr_app;

INSERT INTO "access_roles" ("code", "scope", "description") VALUES ('FINANCE_CONTROLLER', 'ORGANIZATION', 'Finance controller') ON CONFLICT ("code") DO NOTHING;
-- Like every staff role, a finance controller records their own time and sees colleagues' names.
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('FINANCE_CONTROLLER', 'workforce.self'), ('FINANCE_CONTROLLER', 'workforce.directory')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('acct.view', 'See the books: accounts, journals, ledgers and financial reports'),
  ('acct.post', 'Prepare and post accounting documents and journal entries'),
  ('acct.approve', 'Approve accounting documents that need sign-off'),
  ('acct.control', 'Finance controller: reverse entries, lock periods, close the year, configure the books')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('FINANCE_OFFICER', 'acct.view'), ('FINANCE_OFFICER', 'acct.post'),
  ('FINANCE_CONTROLLER', 'acct.view'), ('FINANCE_CONTROLLER', 'acct.post'), ('FINANCE_CONTROLLER', 'acct.approve'), ('FINANCE_CONTROLLER', 'acct.control'),
  ('HOSPITAL_ADMIN', 'acct.view'), ('HOSPITAL_ADMIN', 'acct.approve'),
  ('ORGANISATION_OWNER', 'acct.view'), ('ORGANISATION_OWNER', 'acct.post'), ('ORGANISATION_OWNER', 'acct.approve'), ('ORGANISATION_OWNER', 'acct.control')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
