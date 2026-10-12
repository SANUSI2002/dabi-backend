ALTER TABLE medical_documents
  ADD COLUMN upload_backend VARCHAR(20) NOT NULL DEFAULT 'legacy',
  ADD COLUMN intake_key VARCHAR(80) UNIQUE,
  ADD COLUMN scan_lease_token TEXT,
  ADD COLUMN scan_lease_expires_at TIMESTAMP(3),
  ADD COLUMN scan_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN scan_error_code VARCHAR(80),
  ADD COLUMN storage_cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN cleanup_object_keys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE medical_documents ADD CONSTRAINT medical_documents_scan_attempts_nonnegative CHECK (scan_attempts >= 0);
CREATE INDEX medical_documents_processing_idx ON medical_documents(status, scan_lease_expires_at) WHERE upload_backend = 'supabase';
CREATE INDEX medical_documents_cleanup_idx ON medical_documents(storage_cleanup_pending) WHERE storage_cleanup_pending = TRUE;
