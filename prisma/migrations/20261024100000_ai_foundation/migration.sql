CREATE TABLE "ai_sessions" (
  "id" TEXT PRIMARY KEY, "owner_user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "title" VARCHAR(120) NOT NULL, "mode" VARCHAR(32) NOT NULL DEFAULT 'GENERAL' CHECK (mode = 'GENERAL'),
  "consent_version" VARCHAR(64) NOT NULL, "consented_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "archived_at" TIMESTAMP(3), "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ai_sessions_owner_user_id_updated_at_idx" ON "ai_sessions"("owner_user_id", "updated_at");
CREATE TABLE "ai_runs" (
  "id" TEXT PRIMARY KEY, "session_id" TEXT NOT NULL REFERENCES "ai_sessions"("id") ON DELETE RESTRICT,
  "client_message_id" VARCHAR(64) NOT NULL, "request_hash" VARCHAR(64) NOT NULL, "auth_session_id" TEXT,
  "status" VARCHAR(24) NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  "model" VARCHAR(120) NOT NULL, "prompt_version" VARCHAR(64) NOT NULL, "error_code" VARCHAR(64), "usage" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "started_at" TIMESTAMP(3), "finished_at" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "ai_runs_session_id_client_message_id_key" ON "ai_runs"("session_id","client_message_id");
CREATE UNIQUE INDEX "ai_runs_one_active_per_session" ON "ai_runs"("session_id") WHERE status IN ('QUEUED','RUNNING');
CREATE INDEX "ai_runs_status_created_at_idx" ON "ai_runs"("status","created_at");
CREATE TABLE "ai_messages" (
  "id" TEXT PRIMARY KEY, "session_id" TEXT NOT NULL REFERENCES "ai_sessions"("id") ON DELETE RESTRICT,
  "run_id" TEXT NOT NULL REFERENCES "ai_runs"("id") ON DELETE RESTRICT,
  "role" VARCHAR(16) NOT NULL CHECK (role IN ('user','assistant')), "content" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ai_messages_run_id_role_key" ON "ai_messages"("run_id","role");
CREATE INDEX "ai_messages_session_id_created_at_idx" ON "ai_messages"("session_id","created_at");
-- Defence in depth for non-API roles: no direct browser access policies.
-- The existing Prisma server role is privileged; owner checks remain mandatory in every service query.
ALTER TABLE "ai_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ai_messages" ENABLE ROW LEVEL SECURITY;
