ALTER TABLE "platform_application_evidence"
ADD COLUMN "storage_bucket" TEXT NOT NULL DEFAULT 'sabi-hospital-evidence-quarantine';

ALTER TABLE "platform_application_evidence"
ADD CONSTRAINT "platform_application_evidence_storage_bucket_check"
CHECK ("storage_bucket" IN ('sabi-hospital-evidence-quarantine', 'sabi-hospital-evidence-clean'));
