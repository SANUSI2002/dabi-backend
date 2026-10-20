ALTER TABLE ai_runs ADD COLUMN source_context JSONB;
CREATE UNIQUE INDEX medical_documents_id_owner_patient_id_key ON medical_documents(id,owner_patient_id);
CREATE TABLE ai_document_sources (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  document_id TEXT NOT NULL, client_request_id VARCHAR(64) NOT NULL,
  source_sha256 CHAR(64) NOT NULL, auth_session_id TEXT,
  state VARCHAR(24) NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','EXTRACTING','NEEDS_REVIEW','READY','FAILED','DELETED')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0), model VARCHAR(120) NOT NULL,
  prompt_version VARCHAR(64) NOT NULL, consent_version VARCHAR(64) NOT NULL,
  error_code VARCHAR(64), patient_labels JSONB NOT NULL DEFAULT '[]', usage JSONB,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, started_at TIMESTAMP(3),
  finished_at TIMESTAMP(3), reviewed_at TIMESTAMP(3), deleted_at TIMESTAMP(3),
  CONSTRAINT ai_document_sources_document_id_owner_user_id_fkey
    FOREIGN KEY(document_id,owner_user_id) REFERENCES medical_documents(id,owner_patient_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX ai_document_sources_owner_user_id_client_request_id_key ON ai_document_sources(owner_user_id,client_request_id);
CREATE UNIQUE INDEX ai_document_sources_active_document_key ON ai_document_sources(document_id) WHERE deleted_at IS NULL;
CREATE INDEX ai_document_sources_state_created_at_idx ON ai_document_sources(state,created_at);
CREATE INDEX ai_document_sources_owner_user_id_deleted_at_idx ON ai_document_sources(owner_user_id,deleted_at);
CREATE TABLE ai_document_pages (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES ai_document_sources(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL CHECK(page_number BETWEEN 1 AND 50), original_text TEXT NOT NULL,
  text TEXT NOT NULL, uncertain BOOLEAN NOT NULL DEFAULT TRUE, fields JSONB NOT NULL
);
CREATE UNIQUE INDEX ai_document_pages_source_id_page_number_key ON ai_document_pages(source_id,page_number);
ALTER TABLE ai_document_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_document_pages ENABLE ROW LEVEL SECURITY;
