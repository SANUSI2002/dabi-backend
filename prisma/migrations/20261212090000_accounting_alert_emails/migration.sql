-- Accounting alerts by email: staff who opt in ("emailDigest" in their notification preferences) get a
-- digest of their alerts. Each alert emailed to a person is remembered, so the next digest holds only
-- what is new (or still outstanding a week later); the row "~digest" paces each person's digests and is
-- claimed before sending, so two API instances never send the same digest. The worker finds who opted
-- in across organizations under its own system context (read-only); everything else it reads per
-- organization, as that organization.
CREATE TABLE "acct_alert_deliveries" (
  "organization_id" TEXT NOT NULL, "user_id" TEXT NOT NULL, "alert_id" VARCHAR(80) NOT NULL,
  "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "acct_alert_deliveries_pkey" PRIMARY KEY ("organization_id", "user_id", "alert_id")
);
ALTER TABLE "acct_alert_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_alert_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "acct_alert_deliveries_tenant" ON "acct_alert_deliveries" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "acct_alert_deliveries" TO sabi_emr_app;
GRANT UPDATE ("sent_at") ON "acct_alert_deliveries" TO sabi_emr_app;

CREATE POLICY "acct_notification_prefs_alert_worker_read" ON "acct_notification_prefs" FOR SELECT
  USING (current_setting('app.system_context', true) = 'finance-alert-worker');
