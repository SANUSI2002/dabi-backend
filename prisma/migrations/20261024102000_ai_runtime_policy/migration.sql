CREATE TABLE ai_runtime_policy (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  generation_paused BOOLEAN NOT NULL DEFAULT false,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO ai_runtime_policy (id) VALUES ('global');
ALTER TABLE ai_runtime_policy ENABLE ROW LEVEL SECURITY;
