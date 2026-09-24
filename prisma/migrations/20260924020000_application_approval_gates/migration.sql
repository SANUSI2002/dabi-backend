CREATE TABLE "platform_application_evidence" (
  "id" TEXT NOT NULL,
  "application_id" TEXT NOT NULL,
  "requirement_key" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" TEXT NOT NULL,
  "storage_key" TEXT NOT NULL,
  "scan_status" TEXT NOT NULL DEFAULT 'PENDING',
  "review_status" TEXT NOT NULL DEFAULT 'PENDING',
  "reviewed_by_user_id" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_application_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_application_evidence_size_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760),
  CONSTRAINT "platform_application_evidence_scan_check" CHECK ("scan_status" IN ('PENDING', 'CLEAN', 'INFECTED', 'FAILED')),
  CONSTRAINT "platform_application_evidence_review_check" CHECK ("review_status" IN ('PENDING', 'VERIFIED', 'REJECTED'))
);
CREATE UNIQUE INDEX "platform_application_evidence_application_id_requirement_key_key" ON "platform_application_evidence"("application_id", "requirement_key");
CREATE INDEX "platform_application_evidence_application_id_scan_status_review_status_idx" ON "platform_application_evidence"("application_id", "scan_status", "review_status");
ALTER TABLE "platform_application_evidence" ADD CONSTRAINT "platform_application_evidence_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "platform_applications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('platform.onboarding.approve', 'Approve verified healthcare organization applications')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('SABI_SUPER_ADMIN', 'platform.onboarding.approve'),
  ('SABI_PLATFORM_ADMIN', 'platform.onboarding.approve')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
