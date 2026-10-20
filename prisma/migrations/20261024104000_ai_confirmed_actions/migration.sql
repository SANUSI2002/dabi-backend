CREATE UNIQUE INDEX medication_schedules_id_user_id_key ON medication_schedules(id,user_id);
CREATE TABLE ai_action_proposals (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL, schedule_id TEXT NOT NULL, schedule_version INTEGER NOT NULL CHECK(schedule_version > 0),
  enable_reminders BOOLEAN NOT NULL, client_request_id VARCHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPLIED','CANCELLED')),
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TIMESTAMP(3) NOT NULL, confirmed_at TIMESTAMP(3),
  CONSTRAINT ai_action_proposals_session_owner_fkey FOREIGN KEY(session_id,owner_user_id) REFERENCES ai_sessions(id,owner_user_id) ON DELETE RESTRICT,
  CONSTRAINT ai_action_proposals_schedule_owner_fkey FOREIGN KEY(schedule_id,owner_user_id) REFERENCES medication_schedules(id,user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX ai_action_proposals_owner_user_id_client_request_id_key ON ai_action_proposals(owner_user_id,client_request_id);
CREATE INDEX ai_action_proposals_session_id_created_at_idx ON ai_action_proposals(session_id,created_at);
CREATE TABLE ai_action_receipts (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES ai_action_proposals(id) ON DELETE RESTRICT,
  result JSONB NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE FUNCTION deny_ai_receipt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AI action receipts are append-only' USING ERRCODE='23514'; END;
$$;
CREATE TRIGGER ai_action_receipts_append_only BEFORE UPDATE OR DELETE ON ai_action_receipts
  FOR EACH ROW EXECUTE FUNCTION deny_ai_receipt_mutation();
ALTER TABLE ai_action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_receipts ENABLE ROW LEVEL SECURITY;
