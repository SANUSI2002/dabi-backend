-- MFA methods are authoritative. Existing profile boolean preferences alone do
-- not prove an authenticator was enrolled; reset them to an accurate state.
UPDATE "user_profiles" SET "two_factor_auth" = false WHERE "two_factor_auth" = true;

ALTER TABLE "auth_sessions" ADD COLUMN "mfa_verified_at" TIMESTAMP(3);

CREATE TABLE "mfa_totp" (
  "user_id" TEXT NOT NULL,
  "encrypted_secret" TEXT NOT NULL,
  "enabled_at" TIMESTAMP(3),
  "last_used_step" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_totp_pkey" PRIMARY KEY ("user_id")
);
ALTER TABLE "mfa_totp" ADD CONSTRAINT "mfa_totp_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "mfa_recovery_codes" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "used_at" TIMESTAMP(3),
  CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mfa_recovery_codes_token_hash_key" ON "mfa_recovery_codes"("token_hash");
CREATE INDEX "mfa_recovery_codes_user_id_used_at_idx" ON "mfa_recovery_codes"("user_id", "used_at");
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "mfa_login_challenges" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  CONSTRAINT "mfa_login_challenges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "mfa_login_challenges_token_hash_key" ON "mfa_login_challenges"("token_hash");
CREATE INDEX "mfa_login_challenges_user_id_expires_at_idx" ON "mfa_login_challenges"("user_id", "expires_at");
ALTER TABLE "mfa_login_challenges" ADD CONSTRAINT "mfa_login_challenges_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
