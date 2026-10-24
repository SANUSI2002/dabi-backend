-- Server-only coordination metadata. No patient content or provider secrets.
CREATE TABLE runtime_job_checkpoints (
  id VARCHAR(64) PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{0,63}$'),
  cursor VARCHAR(200),
  next_due_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);
-- No PUBLIC grants or automatic application-group grant. The reviewed runtime
-- grants give SELECT/INSERT/UPDATE only to the attached worker identity.
