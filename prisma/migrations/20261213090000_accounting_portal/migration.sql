-- Self-service portal links: a customer or supplier opens their statement, invoices (or bills and
-- remittance advice) and the hospital's payment instructions from a link, without an account. Only the
-- SHA-256 of the link's token is stored; a link expires (at most 180 days) and can be revoked. The
-- portal finds a link by its hash under its own system context (read-only, nothing else); everything
-- else is read as the link's organization. A link emailed to a customer is recorded as a "portal" notice.
CREATE TABLE "acct_portal_links" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL,
  "party_kind" VARCHAR(8) NOT NULL, "party_id" TEXT NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "created_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL, "revoked_at" TIMESTAMP(3), "revoked_by_user_id" TEXT,
  "last_used_at" TIMESTAMP(3), "use_count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "acct_portal_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_portal_links_check" CHECK (
    "party_kind" IN ('customer', 'vendor') AND "token_hash" ~ '^[0-9a-f]{64}$'
    AND "expires_at" > "created_at" AND "expires_at" <= "created_at" + INTERVAL '181 days'
    AND ("revoked_at" IS NULL) = ("revoked_by_user_id" IS NULL) AND "use_count" >= 0)
);
CREATE UNIQUE INDEX "acct_portal_links_token_key" ON "acct_portal_links"("token_hash");
CREATE INDEX "acct_portal_links_party_idx" ON "acct_portal_links"("organization_id", "party_kind", "party_id");
ALTER TABLE "acct_portal_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_portal_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "acct_portal_links_tenant" ON "acct_portal_links" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
CREATE POLICY "acct_portal_links_lookup" ON "acct_portal_links" FOR SELECT USING (current_setting('app.system_context', true) = 'finance-portal');
GRANT SELECT, INSERT ON "acct_portal_links" TO sabi_emr_app;
GRANT UPDATE ("revoked_at", "revoked_by_user_id", "last_used_at", "use_count") ON "acct_portal_links" TO sabi_emr_app;

ALTER TABLE "acct_customer_notices" DROP CONSTRAINT "acct_customer_notices_check";
ALTER TABLE "acct_customer_notices" ADD CONSTRAINT "acct_customer_notices_check" CHECK (
  "kind" IN ('reminder', 'statement', 'invoice', 'portal')
  AND (("kind" = 'reminder') = ("level" IS NOT NULL))
  AND (("kind" IN ('reminder', 'invoice')) = ("invoice_id" IS NOT NULL))
);
