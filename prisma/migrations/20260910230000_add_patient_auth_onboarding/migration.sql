-- Additive rollout: existing profiles remain valid with consent defaulting to false.
ALTER TABLE "user_profiles"
  ADD COLUMN "consent_given" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "consent_given_at" TIMESTAMP(3),
  ADD COLUMN "gender" TEXT;

CREATE TYPE "UserRoleType" AS ENUM ('PATIENT');

CREATE TABLE "user_roles" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" "UserRoleType" NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_roles_user_id_role_key" ON "user_roles"("user_id", "role");
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "refresh_tokens" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "refresh_tokens_token_key" ON "refresh_tokens"("token");
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
