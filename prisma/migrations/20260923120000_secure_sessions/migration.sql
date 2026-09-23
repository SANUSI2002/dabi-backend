-- Additive migration: existing users and legacy refresh-token rows are retained.
-- Legacy bearer refresh tokens are no longer accepted after the application cutover.
CREATE TABLE "auth_devices" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "label" VARCHAR(160) NOT NULL,
  "user_agent" VARCHAR(512),
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_devices_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "auth_devices_user_id_idx" ON "auth_devices"("user_id");
ALTER TABLE "auth_devices" ADD CONSTRAINT "auth_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auth_sessions" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "auth_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auth_refresh_credentials" (
  "id" TEXT NOT NULL,
  "session_id" TEXT NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "auth_refresh_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "auth_refresh_credentials_token_hash_key" ON "auth_refresh_credentials"("token_hash");
CREATE INDEX "auth_refresh_credentials_session_id_revoked_at_idx" ON "auth_refresh_credentials"("session_id", "revoked_at");
CREATE INDEX "auth_refresh_credentials_expires_at_idx" ON "auth_refresh_credentials"("expires_at");
ALTER TABLE "auth_refresh_credentials" ADD CONSTRAINT "auth_refresh_credentials_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
