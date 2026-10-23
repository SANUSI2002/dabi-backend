-- Attachments on accounting records (a supplier's invoice on a bill, a remittance advice on an invoice).
-- The file goes to the private finance bucket's quarantine/ area; a scanner checks it; only a CLEAN file
-- is copied to clean/ and can be opened, through a short-lived signed link. Removing one keeps the row
-- (who, when) and queues the stored bytes for deletion. Re-attaching the same file name makes a new
-- version. The scan worker reads and updates rows across organizations under its own system context.
CREATE TABLE "acct_attachments" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL,
  "entity_type" VARCHAR(20) NOT NULL, "entity_id" TEXT NOT NULL, "entity_label" VARCHAR(120) NOT NULL,
  "filename" VARCHAR(200) NOT NULL, "content_type" VARCHAR(40) NOT NULL, "byte_size" INTEGER NOT NULL, "sha256" CHAR(64) NOT NULL,
  "note" VARCHAR(300), "version" INTEGER NOT NULL DEFAULT 1, "intake_key" VARCHAR(80) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING_UPLOAD', "object_key" VARCHAR(250) NOT NULL,
  "scan_requested_at" TIMESTAMP(3), "scan_attempts" INTEGER NOT NULL DEFAULT 0, "scan_error_code" VARCHAR(60),
  "scan_lease_token" TEXT, "scan_lease_expires_at" TIMESTAMP(3), "scanned_at" TIMESTAMP(3), "scanner_version" VARCHAR(120),
  "cleanup_object_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "storage_cleanup_pending" BOOLEAN NOT NULL DEFAULT false,
  "uploaded_by_user_id" TEXT NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "removed_at" TIMESTAMP(3), "removed_by_user_id" TEXT,
  CONSTRAINT "acct_attachments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "acct_attachments_values_check" CHECK (
    "entity_type" IN ('invoice', 'bill') AND "content_type" IN ('application/pdf', 'image/jpeg', 'image/png') AND
    "byte_size" > 0 AND "version" >= 1 AND "scan_attempts" BETWEEN 0 AND 5 AND
    "status" IN ('PENDING_UPLOAD', 'PENDING_SCAN', 'CLEAN', 'INFECTED', 'REJECTED', 'REMOVED') AND
    (("status" = 'REMOVED') = ("removed_at" IS NOT NULL AND "removed_by_user_id" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "acct_attachments_intake_key" ON "acct_attachments"("organization_id", "intake_key");
CREATE INDEX "acct_attachments_entity_idx" ON "acct_attachments"("organization_id", "entity_type", "entity_id");
CREATE INDEX "acct_attachments_scan_idx" ON "acct_attachments"("status", "scan_requested_at");

ALTER TABLE "acct_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "acct_attachments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "acct_attachments_tenant" ON "acct_attachments"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
-- the scan worker: every organization's rows, but only its own columns (see the grants below)
CREATE POLICY "acct_attachments_scanner_read" ON "acct_attachments" FOR SELECT
  USING (current_setting('app.system_context', true) = 'finance-document-scanner');
CREATE POLICY "acct_attachments_scanner_write" ON "acct_attachments" FOR UPDATE
  USING (current_setting('app.system_context', true) = 'finance-document-scanner')
  WITH CHECK (current_setting('app.system_context', true) = 'finance-document-scanner');
GRANT SELECT, INSERT ON "acct_attachments" TO sabi_emr_app;
GRANT UPDATE ("status", "object_key", "scan_requested_at", "scan_attempts", "scan_error_code", "scan_lease_token", "scan_lease_expires_at",
  "scanned_at", "scanner_version", "cleanup_object_keys", "storage_cleanup_pending", "removed_at", "removed_by_user_id") ON "acct_attachments" TO sabi_emr_app;
