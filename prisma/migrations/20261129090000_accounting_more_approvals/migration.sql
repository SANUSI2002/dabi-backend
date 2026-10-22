-- Accounting: the organization's approval rules now also hold manual journal entries and vendor payments
-- (the starter rules ask the Finance Controller to approve either at ₦1,000,000 or more). A manual entry
-- that a rule covers waits as "Pending Approval" and posts only once approved; a payment that a rule
-- covers is recorded without touching the bank or the bills, and is posted — its allocations checked
-- again against what is then owed — only once approved. Rejected ones are void / rejected.

ALTER TABLE "acct_journal_entries" ADD COLUMN "approval" JSONB;
GRANT UPDATE ("approval") ON "acct_journal_entries" TO sabi_emr_app;

ALTER TABLE "acct_vendor_payments" ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'Posted', ADD COLUMN "approval" JSONB, ALTER COLUMN "journal_entry_id" DROP NOT NULL;
ALTER TABLE "acct_vendor_payments" ADD CONSTRAINT "acct_vendor_payments_status_check"
  CHECK ("status" IN ('Pending Approval', 'Posted', 'Rejected') AND (("status" = 'Posted') = ("journal_entry_id" IS NOT NULL)));
GRANT UPDATE ("status", "approval", "journal_entry_id") ON "acct_vendor_payments" TO sabi_emr_app;
