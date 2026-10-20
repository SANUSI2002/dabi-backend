-- Accounting, part 3: payables. Vendors, purchase requisitions, purchase orders, goods receipts, bills,
-- vendor payments (with withholding tax) and vendor credits. Requisitions and bills carry an approval
-- built from the organization's approval rules (acct_approval_rules): each step names a finance role, and
-- nobody approves a document they submitted. A posted bill or payment is a journal entry through the
-- ledger; voiding a bill reverses it.

CREATE TABLE "acct_vendors" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "name" VARCHAR(160) NOT NULL, "email" VARCHAR(160), "phone" VARCHAR(30), "address" VARCHAR(300), "tax_id" VARCHAR(40),
  "category" VARCHAR(16) NOT NULL, "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN', "payment_terms_days" INTEGER NOT NULL DEFAULT 30, "payment_term_id" VARCHAR(60),
  "ap_account_number" INTEGER NOT NULL DEFAULT 2000, "active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_vendors_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_vendors_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "acct_vendors_account_fkey" FOREIGN KEY ("organization_id", "ap_account_number") REFERENCES "acct_accounts"("organization_id", "number") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_vendors_check" CHECK ("category" IN ('Pharmaceuticals', 'Medical Supplies', 'Equipment', 'Utilities', 'Services', 'Facilities', 'Other') AND "payment_terms_days" BETWEEN 0 AND 365)
);

-- Requisitions, purchase orders, bills and vendor credits: numbered documents with purchase lines.
CREATE TABLE "acct_purchase_docs" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "kind" VARCHAR(13) NOT NULL, "number" VARCHAR(40) NOT NULL, "vendor_id" TEXT, "vendor_invoice_number" VARCHAR(60),
  "doc_date" TIMESTAMP(3) NOT NULL, "due_date" TIMESTAMP(3), "need_by" TIMESTAMP(3), "expected_date" TIMESTAMP(3), "lines" JSONB NOT NULL, "notes" VARCHAR(2000),
  "justification" VARCHAR(2000), "reason" VARCHAR(500), "department" VARCHAR(120), "status" VARCHAR(20) NOT NULL, "approval" JSONB,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN', "exchange_rate" DECIMAL(16,6) NOT NULL DEFAULT 1, "amount_paid" DECIMAL(16,2) NOT NULL DEFAULT 0,
  "source_doc_id" TEXT, "converted_to_id" TEXT, "journal_entry_id" TEXT, "project_id" TEXT,
  "recur_every_months" INTEGER, "recur_next_date" TIMESTAMP(3), "recur_end_date" TIMESTAMP(3),
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "posted_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "acct_purchase_docs_pkey" PRIMARY KEY ("id"), CONSTRAINT "acct_purchase_docs_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "acct_purchase_docs_vendor_fkey" FOREIGN KEY ("organization_id", "vendor_id") REFERENCES "acct_vendors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_purchase_docs_entry_fkey" FOREIGN KEY ("organization_id", "journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_purchase_docs_check" CHECK (
    "kind" IN ('requisition', 'po', 'bill', 'vendor-credit') AND jsonb_typeof("lines") = 'array' AND "exchange_rate" > 0 AND "amount_paid" >= 0 AND
    ("kind" = 'requisition' OR "vendor_id" IS NOT NULL) AND ("recur_every_months" IS NULL OR "recur_every_months" BETWEEN 1 AND 24)
  )
);
CREATE UNIQUE INDEX "acct_purchase_docs_number_key" ON "acct_purchase_docs"("organization_id", "kind", "number");
CREATE INDEX "acct_purchase_docs_vendor_idx" ON "acct_purchase_docs"("organization_id", "vendor_id");

CREATE TABLE "acct_goods_receipts" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "number" VARCHAR(40) NOT NULL, "purchase_order_id" TEXT NOT NULL, "vendor_id" TEXT NOT NULL,
  "receipt_date" TIMESTAMP(3) NOT NULL, "received_by_user_id" TEXT NOT NULL, "lines" JSONB NOT NULL, "notes" VARCHAR(2000), "stocked_line_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_goods_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_goods_receipts_po_fkey" FOREIGN KEY ("organization_id", "purchase_order_id") REFERENCES "acct_purchase_docs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_goods_receipts_check" CHECK (jsonb_typeof("lines") = 'array')
);
CREATE UNIQUE INDEX "acct_goods_receipts_number_key" ON "acct_goods_receipts"("organization_id", "number");

CREATE TABLE "acct_vendor_payments" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "number" VARCHAR(40) NOT NULL, "vendor_id" TEXT NOT NULL, "payment_date" TIMESTAMP(3) NOT NULL,
  "method" VARCHAR(13) NOT NULL, "from_account_number" INTEGER NOT NULL, "amount" DECIMAL(16,2) NOT NULL, "allocations" JSONB NOT NULL, "settlement_rate" DECIMAL(16,6),
  "reference" VARCHAR(100), "withheld_tax" DECIMAL(16,2) NOT NULL DEFAULT 0, "journal_entry_id" TEXT NOT NULL, "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_vendor_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_vendor_payments_vendor_fkey" FOREIGN KEY ("organization_id", "vendor_id") REFERENCES "acct_vendors"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_vendor_payments_entry_fkey" FOREIGN KEY ("organization_id", "journal_entry_id") REFERENCES "acct_journal_entries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_vendor_payments_check" CHECK ("amount" > 0 AND "withheld_tax" >= 0 AND "method" IN ('Bank Transfer', 'Cheque', 'Cash') AND jsonb_typeof("allocations") = 'array')
);
CREATE UNIQUE INDEX "acct_vendor_payments_number_key" ON "acct_vendor_payments"("organization_id", "number");

CREATE TABLE "acct_vendor_credit_applications" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "vendor_credit_id" TEXT NOT NULL, "bill_id" TEXT NOT NULL, "amount" DECIMAL(16,2) NOT NULL,
  "applied_by_user_id" TEXT NOT NULL, "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_vendor_credit_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_vendor_credit_applications_credit_fkey" FOREIGN KEY ("organization_id", "vendor_credit_id") REFERENCES "acct_purchase_docs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_vendor_credit_applications_bill_fkey" FOREIGN KEY ("organization_id", "bill_id") REFERENCES "acct_purchase_docs"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "acct_vendor_credit_applications_check" CHECK ("amount" > 0)
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['acct_vendors', 'acct_purchase_docs', 'acct_goods_receipts', 'acct_vendor_payments', 'acct_vendor_credit_applications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("name", "email", "phone", "address", "tax_id", "category", "currency", "payment_terms_days", "payment_term_id", "active", "version") ON "acct_vendors" TO sabi_emr_app;
GRANT UPDATE ("vendor_id", "vendor_invoice_number", "doc_date", "due_date", "need_by", "expected_date", "lines", "notes", "status", "approval", "exchange_rate", "amount_paid",
  "converted_to_id", "journal_entry_id", "recur_next_date", "posted_at", "version") ON "acct_purchase_docs" TO sabi_emr_app;
GRANT UPDATE ("stocked_line_ids") ON "acct_goods_receipts" TO sabi_emr_app;
