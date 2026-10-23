-- Emails to customers (payment reminders, statements): queued with the notice they belong to, sent by a
-- worker through the email provider, retried on outages up to five tries. The worker reads and updates
-- queued emails across organizations under its own system context; nothing else.
CREATE TABLE "acct_email_jobs" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "notice_id" TEXT NOT NULL,
  "recipient" VARCHAR(160) NOT NULL, "reply_to" VARCHAR(160), "from_name" VARCHAR(120) NOT NULL,
  "subject" VARCHAR(300) NOT NULL, "body" VARCHAR(20000) NOT NULL,
  "status" VARCHAR(8) NOT NULL DEFAULT 'QUEUED', "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "last_error" VARCHAR(60),
  "provider_message_id" VARCHAR(120), "sent_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_email_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_email_jobs_values_check" CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED') AND "attempts" BETWEEN 0 AND 5 AND (("status" = 'SENT') = ("sent_at" IS NOT NULL)))
);
CREATE UNIQUE INDEX "acct_email_jobs_notice_key" ON "acct_email_jobs"("organization_id", "notice_id");
CREATE INDEX "acct_email_jobs_due_idx" ON "acct_email_jobs"("status", "next_attempt_at");
ALTER TABLE "acct_email_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_email_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "acct_email_jobs_tenant" ON "acct_email_jobs" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
CREATE POLICY "acct_email_jobs_worker_read" ON "acct_email_jobs" FOR SELECT USING (current_setting('app.system_context', true) = 'finance-email-worker');
CREATE POLICY "acct_email_jobs_worker_write" ON "acct_email_jobs" FOR UPDATE
  USING (current_setting('app.system_context', true) = 'finance-email-worker') WITH CHECK (current_setting('app.system_context', true) = 'finance-email-worker');
GRANT SELECT, INSERT ON "acct_email_jobs" TO sabi_emr_app;
GRANT UPDATE ("status", "attempts", "next_attempt_at", "last_error", "provider_message_id", "sent_at") ON "acct_email_jobs" TO sabi_emr_app;
