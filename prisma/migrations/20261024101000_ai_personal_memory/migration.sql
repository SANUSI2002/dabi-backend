ALTER TABLE ai_runs ADD COLUMN feedback VARCHAR(24) CHECK (feedback IN ('HELPFUL','UNCLEAR','UNSAFE'));
ALTER TABLE ai_runs ADD COLUMN feedback_at TIMESTAMP(3);
CREATE UNIQUE INDEX ai_sessions_id_owner_user_id_key ON ai_sessions(id,owner_user_id);
CREATE UNIQUE INDEX ai_runs_id_session_id_key ON ai_runs(id,session_id);
ALTER TABLE ai_messages DROP CONSTRAINT ai_messages_run_id_fkey;
ALTER TABLE ai_messages ADD CONSTRAINT ai_messages_run_id_session_id_fkey
  FOREIGN KEY (run_id,session_id) REFERENCES ai_runs(id,session_id) ON DELETE RESTRICT;
CREATE INDEX ai_runs_created_at_idx ON ai_runs(created_at);
CREATE TABLE ai_personal_memories (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind VARCHAR(24) NOT NULL CHECK (kind IN ('PREFERENCE','USER_REPORTED')),
  content VARCHAR(1000) NOT NULL,
  source_session_id TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  deleted_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ai_personal_memories_source_session_id_owner_user_id_fkey
    FOREIGN KEY (source_session_id,owner_user_id) REFERENCES ai_sessions(id,owner_user_id) ON DELETE RESTRICT
);
CREATE INDEX ai_personal_memories_owner_user_id_deleted_at_idx ON ai_personal_memories(owner_user_id,deleted_at);
ALTER TABLE ai_personal_memories ENABLE ROW LEVEL SECURITY;
