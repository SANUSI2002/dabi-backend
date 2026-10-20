-- Accounting, part 7: integrations. The books follow the organization's other Sabi records, server-side:
-- EMR invoices become receivables invoices (and their payments receipts), confirmed payslips become the
-- payroll accrual (and paid ones its settlement), and pharmacy dispenses relieve drug inventory to cost of
-- sales. Each source record is posted once: acct_integration_events remembers what was posted, so a sync
-- can be run any number of times. A reversed EMR payment voids the receipt it produced.

CREATE TABLE "acct_integration_events" (
  "organization_id" TEXT NOT NULL, "kind" VARCHAR(24) NOT NULL, "source_ref" TEXT NOT NULL, "data" JSONB NOT NULL DEFAULT '{}',
  "journal_entry_id" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_integration_events_pkey" PRIMARY KEY ("organization_id", "kind", "source_ref"),
  CONSTRAINT "acct_integration_events_check" CHECK ("kind" IN ('emr-patient', 'emr-invoice', 'emr-invoice-void', 'emr-payment', 'emr-payment-reversal', 'payslip-accrual', 'payslip-paid', 'dispense-line'))
);
ALTER TABLE "acct_integration_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_integration_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "acct_integration_events_tenant" ON "acct_integration_events" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "acct_integration_events" TO sabi_emr_app;
GRANT UPDATE ("data", "journal_entry_id", "updated_at") ON "acct_integration_events" TO sabi_emr_app;

-- A receipt can be voided (its entry reversed) when the payment behind it is reversed.
ALTER TABLE "acct_receipts" ADD COLUMN "voided_at" TIMESTAMP(3);
GRANT UPDATE ("voided_at") ON "acct_receipts" TO sabi_emr_app;
