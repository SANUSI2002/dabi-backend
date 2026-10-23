CREATE UNIQUE INDEX emr_clinical_notes_organization_id_id_encounter_id_key ON emr_clinical_notes(organization_id,id,encounter_id);
CREATE TABLE emr_jev_policies (
 organization_id TEXT NOT NULL REFERENCES identity_organizations(id) ON DELETE RESTRICT,
 workflow VARCHAR(80) NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 mode VARCHAR(24) NOT NULL DEFAULT 'DISABLED' CHECK(mode IN ('DISABLED','SHADOW','REVIEW_ONLY')),
 question_version VARCHAR(80) NOT NULL, model VARCHAR(120) NOT NULL,
 clinical_owner_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
 approval_reference VARCHAR(200), processing_approved_at TIMESTAMP(3), updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(organization_id,workflow)
);
CREATE TABLE emr_jev_assessments (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, note_id TEXT NOT NULL, encounter_id TEXT NOT NULL,
 requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, client_request_id VARCHAR(64) NOT NULL,
 workflow VARCHAR(80) NOT NULL, question_version VARCHAR(80) NOT NULL, source_fingerprint VARCHAR(64) NOT NULL,
 note_version INTEGER NOT NULL CHECK(note_version>0), policy_version INTEGER NOT NULL CHECK(policy_version>0), mode VARCHAR(24) NOT NULL CHECK(mode IN ('SHADOW','REVIEW_ONLY')),
 requested_model VARCHAR(120) NOT NULL, resolved_model VARCHAR(120),
 processing_status VARCHAR(24) NOT NULL DEFAULT 'QUEUED' CHECK(processing_status IN ('QUEUED','RUNNING','COMPLETED','ABSTAINED','FAILED','DISABLED','STALE')),
 answers JSONB, usage JSONB, error_code VARCHAR(80), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, finished_at TIMESTAMP(3),
 UNIQUE(organization_id,id), UNIQUE(organization_id,client_request_id), UNIQUE(organization_id,note_id,source_fingerprint,policy_version,question_version),
 FOREIGN KEY(organization_id,note_id,encounter_id) REFERENCES emr_clinical_notes(organization_id,id,encounter_id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,encounter_id) REFERENCES emr_encounters(organization_id,id) ON DELETE RESTRICT
);
CREATE INDEX emr_jev_assessments_organization_id_note_id_created_at_idx ON emr_jev_assessments(organization_id,note_id,created_at);
CREATE TABLE jev_assessment_jobs (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, assessment_id TEXT NOT NULL UNIQUE,
 requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 status VARCHAR(24) NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','FINISHED')),
 started_at TIMESTAMP(3), finished_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(organization_id,assessment_id) REFERENCES emr_jev_assessments(organization_id,id) ON DELETE RESTRICT
);
CREATE INDEX jev_assessment_jobs_status_created_at_idx ON jev_assessment_jobs(status,created_at);
CREATE TABLE emr_jev_reviews (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, assessment_id TEXT NOT NULL,
 actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT, client_request_id VARCHAR(64) NOT NULL,
 disposition VARCHAR(24) NOT NULL CHECK(disposition IN ('ACCEPTED','REJECTED','DEFERRED')),
 reason VARCHAR(2000) NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(organization_id,assessment_id) REFERENCES emr_jev_assessments(organization_id,id) ON DELETE RESTRICT,
 UNIQUE(organization_id,client_request_id)
);
CREATE INDEX emr_jev_reviews_organization_id_assessment_id_created_at_idx ON emr_jev_reviews(organization_id,assessment_id,created_at);
ALTER TABLE emr_jev_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE emr_jev_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY emr_jev_policies_tenant ON emr_jev_policies USING(organization_id=emr_current_organization()) WITH CHECK(organization_id=emr_current_organization());
ALTER TABLE emr_jev_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE emr_jev_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY emr_jev_assessments_tenant ON emr_jev_assessments USING(organization_id=emr_current_organization()) WITH CHECK(organization_id=emr_current_organization());
ALTER TABLE emr_jev_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE emr_jev_reviews FORCE ROW LEVEL SECURITY;
CREATE POLICY emr_jev_reviews_tenant ON emr_jev_reviews USING(organization_id=emr_current_organization()) WITH CHECK(organization_id=emr_current_organization());
ALTER TABLE jev_assessment_jobs ENABLE ROW LEVEL SECURITY;
-- Requests can enqueue only their own tenant metadata; no clinical text exists in this queue.
CREATE POLICY jev_assessment_jobs_tenant ON jev_assessment_jobs USING(organization_id=emr_current_organization()) WITH CHECK(organization_id=emr_current_organization());
GRANT SELECT ON emr_jev_policies TO sabi_emr_app;
GRANT SELECT,INSERT,UPDATE ON emr_jev_assessments TO sabi_emr_app;
GRANT SELECT,INSERT ON emr_jev_reviews,jev_assessment_jobs TO sabi_emr_app;
CREATE TRIGGER emr_jev_reviews_append_only BEFORE UPDATE OR DELETE ON emr_jev_reviews FOR EACH ROW EXECUTE FUNCTION deny_ai_receipt_mutation();
CREATE FUNCTION emr_jev_policy_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.version=OLD.version+1; NEW.updated_at=CURRENT_TIMESTAMP; RETURN NEW; END;
$$;
CREATE TRIGGER emr_jev_policy_version BEFORE UPDATE ON emr_jev_policies FOR EACH ROW EXECUTE FUNCTION emr_jev_policy_revision();
