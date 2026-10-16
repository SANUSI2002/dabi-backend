-- Google and Apple sign-in: which outside account belongs to which Sabi user. Keyed on the
-- provider's stable subject id (never the email, which can change or be a private relay).
CREATE TABLE "user_identity_providers" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "provider" VARCHAR(20) NOT NULL,
  "subject" VARCHAR(255) NOT NULL,
  "email" VARCHAR(320),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_identity_providers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_identity_providers_provider_check" CHECK ("provider" IN ('GOOGLE', 'APPLE'))
);
CREATE UNIQUE INDEX "user_identity_providers_provider_subject_key" ON "user_identity_providers"("provider", "subject");
CREATE UNIQUE INDEX "user_identity_providers_user_id_provider_key" ON "user_identity_providers"("user_id", "provider");
ALTER TABLE "user_identity_providers" ADD CONSTRAINT "user_identity_providers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
