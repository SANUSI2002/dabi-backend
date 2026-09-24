DROP INDEX IF EXISTS "organisations_owner_id_key";
CREATE INDEX "organisations_owner_id_idx" ON "organisations"("owner_id");

ALTER TABLE "platform_applications"
  ADD COLUMN "approved_organisation_id" TEXT,
  ADD COLUMN "approved_by_user_id" TEXT,
  ADD COLUMN "approved_at" TIMESTAMP(3),
  ADD COLUMN "setup_token_hash" TEXT,
  ADD COLUMN "setup_token_expires_at" TIMESTAMP(3),
  ADD COLUMN "setup_deadline_at" TIMESTAMP(3),
  ADD COLUMN "setup_sent_at" TIMESTAMP(3),
  ADD COLUMN "setup_completed_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "platform_applications_approved_organisation_id_key" ON "platform_applications"("approved_organisation_id");
CREATE UNIQUE INDEX "platform_applications_setup_token_hash_key" ON "platform_applications"("setup_token_hash");
ALTER TABLE "platform_applications" ADD CONSTRAINT "platform_applications_approved_organisation_id_fkey"
  FOREIGN KEY ("approved_organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('platform.onboarding.approve', 'Approve a reviewed hospital for EMR access')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('SABI_SUPER_ADMIN', 'platform.onboarding.approve'),
  ('SABI_PLATFORM_ADMIN', 'platform.onboarding.approve'),
  ('SABI_COMPLIANCE', 'platform.onboarding.approve')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
