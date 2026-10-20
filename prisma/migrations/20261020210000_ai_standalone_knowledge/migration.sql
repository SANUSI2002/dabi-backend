CREATE TABLE ai_enrollments (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
 kind VARCHAR(24) NOT NULL CHECK (kind IN ('PERSONAL','PROFESSIONAL','BUSINESS')),
 status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SUSPENDED')),
 details JSONB NOT NULL, feature_overrides JSONB NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, expires_at TIMESTAMP(3),
 decided_by_user_id TEXT REFERENCES users(id), decision_reason TEXT,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX ai_enrollments_status_created_at_idx ON ai_enrollments(status,created_at);
CREATE TABLE ai_access_policies (id TEXT PRIMARY KEY DEFAULT 'global', version INTEGER NOT NULL DEFAULT 1, settings JSONB NOT NULL, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO ai_access_policies(id,settings) VALUES ('global','{"PERSONAL":{"chat":true,"knowledge":true,"documents":true,"reminders":true,"memory":true},"PROFESSIONAL":{"chat":true,"knowledge":true,"documents":true,"reminders":true,"memory":true},"BUSINESS":{"chat":true,"knowledge":true,"documents":true,"reminders":true,"memory":true}}');
CREATE TABLE ai_knowledge_documents (
 id TEXT PRIMARY KEY, family_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), version INTEGER NOT NULL DEFAULT 1,
 metadata JSONB NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'UPLOADED' CHECK(status IN ('AWAITING_UPLOAD','UPLOADED','PROCESSING','REVIEW_REQUIRED','APPROVED','PUBLISHED','SUPERSEDED','RETIRED','FAILED')),
 scan_status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK(scan_status IN ('PENDING','CLEAN','INFECTED','REJECTED','FAILED')),
 scanner_version TEXT, storage_key TEXT NOT NULL, sha256 VARCHAR(64) NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size>0 AND byte_size<=10485760),
 page_count INTEGER, error_code VARCHAR(80), uploaded_by_user_id TEXT NOT NULL REFERENCES users(id), reviewed_by_user_id TEXT REFERENCES users(id),
 reviewed_at TIMESTAMP(3), published_at TIMESTAMP(3), lease_token TEXT, lease_expires_at TIMESTAMP(3), attempts INTEGER NOT NULL DEFAULT 0,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(family_id,revision)
);
CREATE UNIQUE INDEX ai_knowledge_one_published_version ON ai_knowledge_documents(family_id) WHERE status='PUBLISHED';
CREATE INDEX ai_knowledge_documents_status_created_at_idx ON ai_knowledge_documents(status,created_at);
CREATE TABLE ai_knowledge_passages (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES ai_knowledge_documents(id) ON DELETE RESTRICT,
 page_number INTEGER NOT NULL CHECK(page_number>0 AND page_number<=1000), page_label VARCHAR(40), text TEXT NOT NULL,
 quality VARCHAR(32) NOT NULL DEFAULT 'REVIEW_REQUIRED' CHECK(quality IN ('REVIEW_REQUIRED','APPROVED','EXCLUDED')),
 UNIQUE(document_id,page_number)
);
CREATE INDEX ai_knowledge_search_idx ON ai_knowledge_passages USING GIN(to_tsvector('english',text));
ALTER TABLE ai_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_access_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_passages ENABLE ROW LEVEL SECURITY;
-- No browser/anon policies: only the authenticated server API can read these tables.
