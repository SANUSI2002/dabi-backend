-- EMR billing: price list, charges (captured from clinical records or added manually), invoices,
-- payments and an append-only billing ledger.
-- Money is always an integer number of minor units (kobo). Invariants enforced by the database:
--   amount = quantity × unit price and tax = round(amount × rate) on every charge; invoice totals
--   add up; paid never exceeds total; each clinical source is charged once; the ledger is
--   append-only; tenants isolated by RLS and composite foreign keys.
-- All objects are new; nothing here locks an existing table.

CREATE TYPE "EmrChargeCategory" AS ENUM ('CONSULTATION', 'LAB', 'MEDICATION', 'BED_DAY', 'PROCEDURE', 'OTHER');
CREATE TYPE "EmrChargeStatus" AS ENUM ('UNBILLED', 'INVOICED', 'VOIDED');
CREATE TYPE "EmrInvoiceStatus" AS ENUM ('ISSUED', 'PARTIALLY_PAID', 'PAID', 'VOID');
CREATE TYPE "EmrPaymentMethod" AS ENUM ('CASH', 'CARD', 'POS', 'BANK_TRANSFER', 'MOBILE_MONEY', 'CHEQUE');
CREATE TYPE "EmrPaymentStatus" AS ENUM ('POSTED', 'REVERSED');
CREATE TYPE "EmrLedgerKind" AS ENUM ('INVOICE_ISSUED', 'PAYMENT', 'PAYMENT_REVERSED', 'INVOICE_VOIDED');

-- ---------------------------------------------------------------------------------------------
-- Price list. (category, reference) is what automatic capture looks up:
--   CONSULTATION:<encounter class>  LAB:<test code>  MEDICATION:<drug code> (per dispense unit)
--   BED_DAY:<ward code> or BED_DAY:<ward kind>       PROCEDURE/OTHER: manual charges
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_price_items" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "category" "EmrChargeCategory" NOT NULL,
  "reference" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "unit_price_minor" BIGINT NOT NULL,
  "tax_rate_bp" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_price_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_price_items_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_price_items_reference_key" UNIQUE ("organization_id", "category", "reference"),
  CONSTRAINT "emr_price_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_price_items_amount_check" CHECK ("unit_price_minor" >= 0 AND "tax_rate_bp" BETWEEN 0 AND 10000 AND "currency" ~ '^[A-Z]{3}$')
);

-- ---------------------------------------------------------------------------------------------
-- Invoices (created before charges reference them)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_invoices" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "encounter_id" TEXT NOT NULL,
  "number" TEXT NOT NULL,
  "status" "EmrInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
  "currency" TEXT NOT NULL,
  "subtotal_minor" BIGINT NOT NULL,
  "tax_minor" BIGINT NOT NULL,
  "discount_minor" BIGINT NOT NULL DEFAULT 0,
  "discount_reason" TEXT,
  "total_minor" BIGINT NOT NULL,
  "amount_paid_minor" BIGINT NOT NULL DEFAULT 0,
  "due_date" DATE,
  "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issued_by_user_id" TEXT NOT NULL,
  "voided_at" TIMESTAMP(3),
  "voided_by_user_id" TEXT,
  "void_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_invoices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_invoices_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_invoices_number_key" UNIQUE ("organization_id", "number"),
  CONSTRAINT "emr_invoices_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_invoices_amounts_check" CHECK (
    "subtotal_minor" >= 0 AND "tax_minor" >= 0 AND "discount_minor" >= 0
    AND "discount_minor" <= "subtotal_minor" + "tax_minor"
    AND "total_minor" = "subtotal_minor" + "tax_minor" - "discount_minor"
    AND "amount_paid_minor" >= 0 AND "amount_paid_minor" <= "total_minor"),
  CONSTRAINT "emr_invoices_discount_reason_check" CHECK ("discount_minor" = 0 OR "discount_reason" IS NOT NULL),
  CONSTRAINT "emr_invoices_status_check" CHECK (
    ("status" <> 'PAID' OR "amount_paid_minor" = "total_minor")
    AND ("status" <> 'VOID' OR ("amount_paid_minor" = 0 AND "void_reason" IS NOT NULL))),
  CONSTRAINT "emr_invoices_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);
CREATE INDEX "emr_invoices_organization_id_status_idx" ON "emr_invoices"("organization_id", "status", "issued_at" DESC, "id" DESC);
CREATE INDEX "emr_invoices_organization_id_patient_idx" ON "emr_invoices"("organization_id", "patient_id", "issued_at" DESC);
CREATE INDEX "emr_invoices_organization_id_encounter_idx" ON "emr_invoices"("organization_id", "encounter_id");

-- ---------------------------------------------------------------------------------------------
-- Charges. A clinical source (lab item, dispense line, admission day, visit) is charged once:
-- (source_type, source_key) is unique per tenant, so capture is idempotent.
-- Credits (e.g. returned medicine) are charges with a negative quantity.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_charges" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "encounter_id" TEXT NOT NULL,
  "price_item_id" TEXT,
  "category" "EmrChargeCategory" NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price_minor" BIGINT NOT NULL,
  "tax_rate_bp" INTEGER NOT NULL DEFAULT 0,
  "amount_minor" BIGINT NOT NULL,
  "tax_minor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_key" TEXT,
  "service_at" TIMESTAMP(3) NOT NULL,
  "status" "EmrChargeStatus" NOT NULL DEFAULT 'UNBILLED',
  "invoice_id" TEXT,
  "created_by_user_id" TEXT NOT NULL,
  "voided_at" TIMESTAMP(3),
  "voided_by_user_id" TEXT,
  "void_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_charges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_charges_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_charges_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_charges_price_item_fkey" FOREIGN KEY ("organization_id", "price_item_id") REFERENCES "emr_price_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_charges_invoice_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "emr_invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_charges_arithmetic_check" CHECK (
    "quantity" <> 0 AND "unit_price_minor" >= 0 AND "tax_rate_bp" BETWEEN 0 AND 10000
    AND "amount_minor" = "quantity"::BIGINT * "unit_price_minor"
    AND "tax_minor" = ROUND("amount_minor"::NUMERIC * "tax_rate_bp" / 10000)),
  CONSTRAINT "emr_charges_source_check" CHECK ("source_type" IN ('ENCOUNTER', 'LAB_ORDER_ITEM', 'DISPENSE_LINE', 'DISPENSE_RETURN', 'BED_DAY', 'MANUAL')),
  CONSTRAINT "emr_charges_credit_check" CHECK ("quantity" > 0 OR "source_type" = 'DISPENSE_RETURN'),
  CONSTRAINT "emr_charges_status_check" CHECK (
    ("status" = 'INVOICED') = ("invoice_id" IS NOT NULL)
    AND ("status" <> 'VOIDED' OR "void_reason" IS NOT NULL)),
  CONSTRAINT "emr_charges_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "emr_charges_source_key" ON "emr_charges"("organization_id", "source_type", "source_key") WHERE "source_key" IS NOT NULL;
CREATE INDEX "emr_charges_organization_id_encounter_idx" ON "emr_charges"("organization_id", "encounter_id", "status");
CREATE INDEX "emr_charges_organization_id_invoice_idx" ON "emr_charges"("organization_id", "invoice_id");

-- ---------------------------------------------------------------------------------------------
-- Payments
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_payments" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "receipt_number" TEXT NOT NULL,
  "method" "EmrPaymentMethod" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "reference" TEXT,
  "status" "EmrPaymentStatus" NOT NULL DEFAULT 'POSTED',
  "received_by_user_id" TEXT NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversed_at" TIMESTAMP(3),
  "reversed_by_user_id" TEXT,
  "reversal_reason" TEXT,
  CONSTRAINT "emr_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_payments_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_payments_receipt_key" UNIQUE ("organization_id", "receipt_number"),
  CONSTRAINT "emr_payments_invoice_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "emr_invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_payments_amount_check" CHECK ("amount_minor" > 0),
  CONSTRAINT "emr_payments_reversal_check" CHECK (
    ("status" = 'POSTED' AND "reversed_at" IS NULL)
    OR ("status" = 'REVERSED' AND "reversed_at" IS NOT NULL AND "reversal_reason" IS NOT NULL
        AND "reversed_by_user_id" IS NOT NULL AND "reversed_by_user_id" <> "received_by_user_id"))
);
CREATE INDEX "emr_payments_organization_id_invoice_idx" ON "emr_payments"("organization_id", "invoice_id", "received_at");

-- ---------------------------------------------------------------------------------------------
-- Billing ledger: every change to what a patient owes, with the running balance. Append-only.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_billing_ledger" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "invoice_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "kind" "EmrLedgerKind" NOT NULL,
  "amount_minor" BIGINT NOT NULL,
  "balance_after_minor" BIGINT NOT NULL,
  "payment_id" TEXT,
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_billing_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_billing_ledger_invoice_fkey" FOREIGN KEY ("organization_id", "invoice_id") REFERENCES "emr_invoices"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_billing_ledger_payment_fkey" FOREIGN KEY ("organization_id", "payment_id") REFERENCES "emr_payments"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_billing_ledger_amount_check" CHECK (
    "balance_after_minor" >= 0
    AND ("kind" <> 'INVOICE_ISSUED' OR "amount_minor" >= 0)
    AND ("kind" <> 'PAYMENT' OR ("amount_minor" < 0 AND "payment_id" IS NOT NULL))
    AND ("kind" <> 'PAYMENT_REVERSED' OR ("amount_minor" > 0 AND "payment_id" IS NOT NULL))
    AND ("kind" <> 'INVOICE_VOIDED' OR "amount_minor" <= 0))
);
CREATE INDEX "emr_billing_ledger_organization_id_invoice_idx" ON "emr_billing_ledger"("organization_id", "invoice_id", "created_at");
CREATE TRIGGER "emr_billing_ledger_append_only" BEFORE UPDATE OR DELETE ON "emr_billing_ledger"
  FOR EACH ROW EXECUTE FUNCTION emr_append_only();

-- ---------------------------------------------------------------------------------------------
-- Row-level security and least-privilege grants
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_price_items', 'emr_invoices', 'emr_charges', 'emr_payments', 'emr_billing_ledger'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON "emr_price_items" TO sabi_emr_app;
-- Invoice amounts are fixed at issue; only payment progress and voiding change afterwards.
GRANT SELECT, INSERT ON "emr_invoices" TO sabi_emr_app;
GRANT UPDATE ("status", "amount_paid_minor", "voided_at", "voided_by_user_id", "void_reason", "version", "updated_at") ON "emr_invoices" TO sabi_emr_app;
-- A charge's money fields never change; only its billing state does.
GRANT SELECT, INSERT ON "emr_charges" TO sabi_emr_app;
GRANT UPDATE ("status", "invoice_id", "voided_at", "voided_by_user_id", "void_reason", "updated_at") ON "emr_charges" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_payments" TO sabi_emr_app;
GRANT UPDATE ("status", "reversed_at", "reversed_by_user_id", "reversal_reason") ON "emr_payments" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_billing_ledger" TO sabi_emr_app;

-- ---------------------------------------------------------------------------------------------
-- Permissions (EMR-specific codes; the existing invoice.* / payment.* codes are left alone).
-- Separation of duties: cashiers record payments; only administrators reverse them.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('billing.read', 'View charges, invoices, payments and statements'),
  ('billing.price.manage', 'Manage the price list'),
  ('billing.charge.manage', 'Add and void manual charges; capture charges'),
  ('billing.invoice.create', 'Issue invoices'),
  ('billing.discount', 'Apply discounts to invoices'),
  ('billing.invoice.void', 'Void unpaid invoices'),
  ('billing.payment.record', 'Record payments'),
  ('billing.payment.reverse', 'Reverse recorded payments')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('FINANCE_OFFICER', 'billing.read'),
  ('FINANCE_OFFICER', 'billing.price.manage'),
  ('FINANCE_OFFICER', 'billing.charge.manage'),
  ('FINANCE_OFFICER', 'billing.invoice.create'),
  ('FINANCE_OFFICER', 'billing.discount'),
  ('FINANCE_OFFICER', 'billing.invoice.void'),
  ('FINANCE_OFFICER', 'billing.payment.record'),
  ('RECEPTIONIST', 'billing.read'),
  ('RECEPTIONIST', 'billing.invoice.create'),
  ('RECEPTIONIST', 'billing.payment.record'),
  ('HOSPITAL_ADMIN', 'billing.read'),
  ('HOSPITAL_ADMIN', 'billing.price.manage'),
  ('HOSPITAL_ADMIN', 'billing.discount'),
  ('HOSPITAL_ADMIN', 'billing.invoice.void'),
  ('HOSPITAL_ADMIN', 'billing.payment.reverse')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
