CREATE TABLE "identity_invitations" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "organization_id" TEXT,
  "role_code" TEXT NOT NULL,
  "invited_by_user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "accepted_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_invitations_scope_check" CHECK (("scope" = 'PLATFORM' AND "organization_id" IS NULL) OR ("scope" = 'ORGANIZATION' AND "organization_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "identity_invitations_token_hash_key" ON "identity_invitations"("token_hash");
CREATE INDEX "identity_invitations_email_scope_organization_id_idx" ON "identity_invitations"("email", "scope", "organization_id");
CREATE INDEX "identity_invitations_expires_at_idx" ON "identity_invitations"("expires_at");
ALTER TABLE "identity_invitations" ADD CONSTRAINT "identity_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "identity_invitations" ADD CONSTRAINT "identity_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
INSERT INTO "access_permissions" ("code", "description") VALUES ('platform.staff.invite', 'Invite limited platform staff roles') ON CONFLICT ("code") DO NOTHING;
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('SABI_SUPER_ADMIN', 'platform.staff.invite'),
  ('SABI_PLATFORM_ADMIN', 'platform.staff.invite')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
