ALTER TABLE pharmacy_inventory_items
 ADD COLUMN reorder_point INTEGER NOT NULL DEFAULT 0 CHECK(reorder_point BETWEEN 0 AND 1000000),
 ADD COLUMN reorder_target INTEGER CHECK(reorder_target BETWEEN 0 AND 1000000),
 ADD COLUMN stock_policy_version INTEGER NOT NULL DEFAULT 1 CHECK(stock_policy_version > 0),
 ADD CONSTRAINT pharmacy_reorder_target_check CHECK(reorder_target IS NULL OR reorder_target >= reorder_point);
CREATE INDEX pharmacy_stock_adjustments_item_created_idx ON pharmacy_stock_adjustments(inventory_item_id,created_at);
CREATE INDEX pharmacy_inventory_branch_expiry_idx ON pharmacy_inventory_items(pharmacy_id,branch_id,expiry_date);
CREATE INDEX pharmacy_fulfilments_created_idx ON order_fulfilments(pharmacy_id,created_at);
CREATE TABLE pharmacy_email_jobs (
 id TEXT PRIMARY KEY, pharmacy_id TEXT NOT NULL REFERENCES pharmacies(id),
 event_key VARCHAR(200) NOT NULL UNIQUE, kind VARCHAR(40) NOT NULL,
 recipient VARCHAR(320) NOT NULL, sender VARCHAR(320), subject VARCHAR(200) NOT NULL, text TEXT NOT NULL,
 expected_status VARCHAR(16), branch_id TEXT REFERENCES pharmacy_branches(id), licence_expiry TIMESTAMP(3),
 status VARCHAR(16) NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','SENT','FAILED','CANCELLED')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), first_attempt_at TIMESTAMP(3),
 next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, lease_token TEXT, lease_expires_at TIMESTAMP(3),
 provider_id TEXT, last_error_code VARCHAR(80), sent_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX pharmacy_email_jobs_status_next_idx ON pharmacy_email_jobs(status,next_attempt_at);
CREATE INDEX pharmacy_email_jobs_pharmacy_created_idx ON pharmacy_email_jobs(pharmacy_id,created_at);
