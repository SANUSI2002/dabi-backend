-- Finance documents by email: a queued customer email can carry one PDF (an invoice copy or a statement
-- of account), at most 5 MB, with its file name; and an invoice can be emailed on its own, recorded as an
-- "invoice" notice like reminders and statements.
ALTER TABLE "acct_email_jobs" ADD COLUMN "attachment_name" VARCHAR(120), ADD COLUMN "attachment" BYTEA;
ALTER TABLE "acct_email_jobs" ADD CONSTRAINT "acct_email_jobs_attachment_check"
  CHECK (("attachment" IS NULL) = ("attachment_name" IS NULL) AND ("attachment" IS NULL OR octet_length("attachment") <= 5242880));

ALTER TABLE "acct_customer_notices" DROP CONSTRAINT "acct_customer_notices_check";
ALTER TABLE "acct_customer_notices" ADD CONSTRAINT "acct_customer_notices_check" CHECK (
  "kind" IN ('reminder', 'statement', 'invoice')
  AND (("kind" = 'reminder') = ("level" IS NOT NULL))
  AND (("kind" = 'statement') = ("invoice_id" IS NULL))
);
