-- Accounting, part 2: settings, tax rates and receivables. Settings hold the company profile, document
-- numbering, payment terms, the reminder (dunning) ladder and tax registration. Tax rates are keyed by a
-- stable id per organization. Receivables: customers, quotations, sales orders, invoices (with revenue
-- schedules and recurrence), receipts and their allocations, credit notes, cash-sale and refund receipts,
-- delayed charges, payment reminders and statement deliveries. Every issued document posts its journal
-- entry through the ledger; voiding reverses it. Reminders and statements record that they were sent —
-- nothing is mailed from here.

CREATE TABLE "acct_settings" (
  "organization_id" TEXT NOT NULL, "org_profile" JSONB NOT NULL, "sequences" JSONB NOT NULL, "payment_terms" JSONB NOT NULL, "reminder_rules" JSONB NOT NULL,
  "tax_registration" JSONB NOT NULL, "setup_steps" JSONB NOT NULL DEFAULT '{}', "version" INTEGER NOT NULL DEFAULT 1, "updated_by_user_id" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_settings_pkey" PRIMARY KEY ("organization_id"),
  CONSTRAINT "acct_settings_check" CHECK (jsonb_typeof("sequences") = 'array' AND jsonb_typeof("payment_terms") = 'array' AND jsonb_typeof("reminder_rules") = 'array')
);

CREATE TABLE "acct_tax_rates" (
  "organization_id" TEXT NOT NULL, "id" VARCHAR(60) NOT NULL, "name" VARCHAR(80) NOT NULL, "kind" VARCHAR(10) NOT NULL, "rate" DECIMAL(7,4) NOT NULL,
  "description" VARCHAR(300), "account_number" INTEGER NOT NULL, "is_compound" BOOLEAN NOT NULL DEFAULT false, "is_active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_tax_rates_pkey" PRIMARY KEY ("organization_id", "id"),
  CONSTRAINT "acct_tax_rates_account_fkey" FOREIGN KEY ("organization_id", "account_number") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_tax_rates_check" CHECK ("kind" IN ('VAT', 'WHT', 'Exempt', 'Zero-rated') AND "rate" BETWEEN 0 AND 100)
);

CREATE TABLE "acct_customers" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(160) NOT NULL, "type" VARCHAR(9) NOT NULL, "email" VARCHAR(160), "phone" VARCHAR(30),
  "address" VARCHAR(300), "city" VARCHAR(80), "ar_account_number" INTEGER NOT NULL, "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN', "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
  "payment_term_id" VARCHAR(60), "credit_limit" DECIMAL(16,2) NOT NULL DEFAULT 0, "credit_hold" BOOLEAN NOT NULL DEFAULT false, "patient_ref" VARCHAR(100),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_customers_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_customers_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "acct_customers_account_fkey" FOREIGN KEY ("organization_id", "ar_account_number") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_customers_check" CHECK ("type" IN ('Patient', 'NHIS', 'HMO', 'Corporate', 'Walk-in') AND "credit_limit" >= 0 AND "payment_terms_days" BETWEEN 0 AND 365)
);

-- Quotations, sales orders, invoices, credit notes, cash-sale and refund receipts share one shape: a
-- numbered document with lines (account, description, qty, unit price, taxes) and a status.
CREATE TABLE "acct_sales_docs" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "kind" VARCHAR(14) NOT NULL, "number" VARCHAR(40) NOT NULL, "customer_id" TEXT, "customer_name" VARCHAR(160),
  "doc_date" TIMESTAMP(3) NOT NULL, "due_date" TIMESTAMP(3), "expiry_date" TIMESTAMP(3), "lines" JSONB NOT NULL, "notes" VARCHAR(2000), "reason" VARCHAR(500),
  "status" VARCHAR(20) NOT NULL, "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN', "exchange_rate" DECIMAL(16,6) NOT NULL DEFAULT 1,
  "amount_paid" DECIMAL(16,2) NOT NULL DEFAULT 0, "refunded_amount" DECIMAL(16,2) NOT NULL DEFAULT 0, "method" VARCHAR(16), "cash_account_number" INTEGER,
  "source_doc_id" TEXT, "converted_to_id" TEXT, "converted_to_invoice_id" TEXT, "journal_entry_id" TEXT, "source" VARCHAR(12) NOT NULL DEFAULT 'Manual', "source_ref" VARCHAR(100),
  "project_id" TEXT, "recur_every_months" INTEGER, "recur_next_date" TIMESTAMP(3), "recur_end_date" TIMESTAMP(3),
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "issued_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_sales_docs_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_sales_docs_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "acct_sales_docs_customer_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "acct_customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_sales_docs_entry_fkey" FOREIGN KEY ("organization_id", "journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_sales_docs_check" CHECK (
    "kind" IN ('estimate', 'sales-order', 'invoice', 'credit-note', 'sales-receipt', 'refund-receipt') AND jsonb_typeof("lines") = 'array' AND
    "exchange_rate" > 0 AND "amount_paid" >= 0 AND "refunded_amount" >= 0 AND ("kind" = 'sales-receipt' OR "customer_id" IS NOT NULL) AND
    ("recur_every_months" IS NULL OR "recur_every_months" BETWEEN 1 AND 24)
  )
);
CREATE UNIQUE INDEX "acct_sales_docs_number_key" ON "acct_sales_docs"("organization_id", "kind", "number");
CREATE INDEX "acct_sales_docs_customer_idx" ON "acct_sales_docs"("organization_id", "customer_id");
-- One Sabi document per EMR bill (the billing bridge is idempotent).
CREATE UNIQUE INDEX "acct_sales_docs_source_ref_key" ON "acct_sales_docs"("organization_id", "source", "source_ref") WHERE "source_ref" IS NOT NULL;

CREATE TABLE "acct_receipts" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "number" VARCHAR(40) NOT NULL, "customer_id" TEXT NOT NULL, "receipt_date" TIMESTAMP(3) NOT NULL,
  "method" VARCHAR(16) NOT NULL, "deposit_account_number" INTEGER NOT NULL, "amount" DECIMAL(16,2) NOT NULL, "allocations" JSONB NOT NULL,
  "settlement_rate" DECIMAL(16,6), "reference" VARCHAR(100), "notes" VARCHAR(2000), "journal_entry_id" TEXT NOT NULL,
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_receipts_customer_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "acct_customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_receipts_entry_fkey" FOREIGN KEY ("organization_id", "journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_receipts_check" CHECK ("amount" > 0 AND jsonb_typeof("allocations") = 'array' AND "method" IN ('Cash', 'Bank Transfer', 'POS', 'Cheque', 'NHIS Remittance'))
);
CREATE UNIQUE INDEX "acct_receipts_number_key" ON "acct_receipts"("organization_id", "number");

-- Credit-note applications and refunds, kept as history (insert-only).
CREATE TABLE "acct_credit_applications" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "credit_note_id" TEXT NOT NULL, "invoice_id" TEXT, "kind" VARCHAR(6) NOT NULL, "amount" DECIMAL(16,2) NOT NULL,
  "cash_account_number" INTEGER, "journal_entry_id" TEXT, "applied_by_user_id" TEXT NOT NULL, "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_credit_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_credit_applications_note_fkey" FOREIGN KEY ("organization_id", "credit_note_id") REFERENCES "acct_sales_docs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_credit_applications_check" CHECK ("kind" IN ('apply', 'refund') AND "amount" > 0 AND (("kind" = 'apply') = ("invoice_id" IS NOT NULL)))
);

CREATE TABLE "acct_revenue_schedules" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "invoice_id" TEXT NOT NULL, "customer_id" TEXT NOT NULL, "total_amount" DECIMAL(16,2) NOT NULL,
  "start_period" VARCHAR(7) NOT NULL, "months" INTEGER NOT NULL, "deferred_account_number" INTEGER NOT NULL, "revenue_account_number" INTEGER NOT NULL,
  "entries" JSONB NOT NULL, "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_revenue_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_revenue_schedules_invoice_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "acct_sales_docs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_revenue_schedules_check" CHECK ("months" BETWEEN 2 AND 120 AND jsonb_typeof("entries") = 'array')
);
CREATE UNIQUE INDEX "acct_revenue_schedules_invoice_key" ON "acct_revenue_schedules"("organization_id", "invoice_id");

CREATE TABLE "acct_delayed_charges" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "customer_id" TEXT NOT NULL, "charge_date" TIMESTAMP(3) NOT NULL, "account_number" INTEGER NOT NULL,
  "description" VARCHAR(300) NOT NULL, "qty" DECIMAL(14,3) NOT NULL, "unit_price" DECIMAL(16,2) NOT NULL, "tax_rate_id" VARCHAR(60), "status" VARCHAR(8) NOT NULL DEFAULT 'Unbilled',
  "invoice_id" TEXT, "removed_at" TIMESTAMP(3), "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_delayed_charges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_delayed_charges_customer_fkey" FOREIGN KEY ("organization_id", "customer_id") REFERENCES "acct_customers"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_delayed_charges_check" CHECK ("status" IN ('Unbilled', 'Invoiced') AND "qty" > 0 AND "unit_price" >= 0 AND (("status" = 'Invoiced') = ("invoice_id" IS NOT NULL)))
);

-- Reminders and statement deliveries: a record that they were sent (insert-only).
CREATE TABLE "acct_customer_notices" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "kind" VARCHAR(9) NOT NULL, "customer_id" TEXT NOT NULL, "invoice_id" TEXT, "level" INTEGER, "tone" VARCHAR(40),
  "sent_to" VARCHAR(160), "sent_by_user_id" TEXT NOT NULL, "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_customer_notices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_customer_notices_check" CHECK ("kind" IN ('reminder', 'statement') AND (("kind" = 'reminder') = ("invoice_id" IS NOT NULL AND "level" IS NOT NULL)))
);
CREATE UNIQUE INDEX "acct_customer_notices_level_key" ON "acct_customer_notices"("organization_id", "invoice_id", "level") WHERE "kind" = 'reminder';

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['acct_settings', 'acct_tax_rates', 'acct_customers', 'acct_sales_docs', 'acct_receipts', 'acct_credit_applications', 'acct_revenue_schedules',
    'acct_delayed_charges', 'acct_customer_notices'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("org_profile", "sequences", "payment_terms", "reminder_rules", "tax_registration", "setup_steps", "version", "updated_by_user_id", "updated_at") ON "acct_settings" TO sabi_emr_app;
GRANT UPDATE ("name", "rate", "description", "account_number", "is_active", "version") ON "acct_tax_rates" TO sabi_emr_app;
GRANT UPDATE ("name", "type", "email", "phone", "address", "city", "ar_account_number", "currency", "payment_terms_days", "payment_term_id", "credit_limit", "credit_hold", "version") ON "acct_customers" TO sabi_emr_app;
GRANT UPDATE ("doc_date", "due_date", "expiry_date", "lines", "notes", "status", "exchange_rate", "amount_paid", "refunded_amount", "converted_to_id", "converted_to_invoice_id",
  "journal_entry_id", "recur_next_date", "issued_at", "version") ON "acct_sales_docs" TO sabi_emr_app;
GRANT UPDATE ("entries", "version") ON "acct_revenue_schedules" TO sabi_emr_app;
GRANT UPDATE ("status", "invoice_id", "removed_at") ON "acct_delayed_charges" TO sabi_emr_app;
