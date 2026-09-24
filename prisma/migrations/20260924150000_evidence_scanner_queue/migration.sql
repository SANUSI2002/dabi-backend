ALTER TABLE "platform_application_evidence"
ADD COLUMN "scan_lease_token" TEXT,
ADD COLUMN "scan_lease_expires_at" TIMESTAMP(3),
ADD COLUMN "scan_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "scan_error_code" TEXT,
ADD COLUMN "scanner_version" TEXT,
ADD COLUMN "scanned_at" TIMESTAMP(3);

CREATE INDEX "platform_application_evidence_scan_status_scan_lease_expires_at_created_at_idx"
ON "platform_application_evidence"("scan_status", "scan_lease_expires_at", "created_at");
