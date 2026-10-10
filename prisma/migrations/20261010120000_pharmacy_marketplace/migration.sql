ALTER TYPE "UserAccountStatus" ADD VALUE IF NOT EXISTS 'BANNED';
CREATE TABLE pharmacy_tiers (
  level INTEGER PRIMARY KEY CHECK (level BETWEEN 1 AND 3), name VARCHAR(80) NOT NULL,
  commission_bps INTEGER NOT NULL CHECK (commission_bps BETWEEN 0 AND 10000),
  delivery_radius_km INTEGER NOT NULL CHECK (delivery_radius_km BETWEEN 1 AND 100),
  max_branches INTEGER CHECK (max_branches BETWEEN 1 AND 10000),
  minimum_order_minor INTEGER NOT NULL DEFAULT 0 CHECK (minimum_order_minor >= 0),
  delivery_enabled BOOLEAN NOT NULL DEFAULT true, pickup_enabled BOOLEAN NOT NULL DEFAULT true,
  enabled BOOLEAN NOT NULL DEFAULT true, version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO pharmacy_tiers (level,name,commission_bps,delivery_radius_km,max_branches) VALUES
 (1,'Tier 1 · Single branch',1500,5,1),(2,'Tier 2 · Up to five branches',2000,7,5),(3,'Tier 3 · Multi-branch',3000,10,NULL);
ALTER TABLE pharmacies ADD COLUMN tier_level INTEGER REFERENCES pharmacy_tiers(level), ADD COLUMN application_submitted_at TIMESTAMP(3), ADD COLUMN registration_details JSONB;
ALTER TABLE pharmacies ADD COLUMN superintendent_licence_expires_at TIMESTAMP(3);
CREATE TABLE pharmacy_branches (
 id TEXT PRIMARY KEY, pharmacy_id TEXT NOT NULL REFERENCES pharmacies(id), name VARCHAR(120) NOT NULL,
 address VARCHAR(300) NOT NULL, latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
 longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
 premises_licence_number VARCHAR(100) NOT NULL, licence_expires_at TIMESTAMP(3) NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
 version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(id,pharmacy_id)
);
CREATE INDEX pharmacy_branches_pharmacy_id_status_idx ON pharmacy_branches(pharmacy_id,status);
ALTER TABLE pharmacy_inventory_items ADD COLUMN branch_id TEXT;
ALTER TABLE pharmacy_inventory_items ADD COLUMN batch_number VARCHAR(100), ADD COLUMN expiry_date DATE;
ALTER TABLE pharmacy_inventory_items ADD CONSTRAINT pharmacy_inventory_branch_fkey FOREIGN KEY(branch_id,pharmacy_id) REFERENCES pharmacy_branches(id,pharmacy_id);
CREATE TABLE pharmacy_stock_adjustments (
 id TEXT PRIMARY KEY, inventory_item_id TEXT NOT NULL REFERENCES pharmacy_inventory_items(id),
 idempotency_key VARCHAR(128) NOT NULL, request_hash CHAR(64) NOT NULL,
 quantity_delta INTEGER NOT NULL, balance_before INTEGER NOT NULL CHECK(balance_before >= 0),
 balance_after INTEGER NOT NULL CHECK(balance_after >= 0), actor_id TEXT NOT NULL REFERENCES users(id),
 reason VARCHAR(1000) NOT NULL, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(inventory_item_id,idempotency_key), CHECK(balance_after = balance_before + quantity_delta)
);
CREATE TABLE pharmacy_credentials (
 id TEXT PRIMARY KEY, pharmacy_id TEXT NOT NULL REFERENCES pharmacies(id), branch_id TEXT,
 kind VARCHAR(40) NOT NULL CHECK(kind IN ('CAC_CERTIFICATE','SUPERINTENDENT_LICENCE','PREMISES_LICENCE','SUPERINTENDENT_APPOINTMENT')),
 content_type TEXT NOT NULL, byte_size INTEGER NOT NULL CHECK(byte_size BETWEEN 1 AND 5242880),
 sha256 CHAR(64) NOT NULL, storage_bucket TEXT NOT NULL, storage_key TEXT NOT NULL,
 scan_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(scan_status IN ('PENDING','CLEAN','INFECTED','FAILED','REJECTED')),
 scan_attempts INTEGER NOT NULL DEFAULT 0, scan_lease_token TEXT, scan_lease_expires_at TIMESTAMP(3),
 scan_error_code TEXT, scanner_version TEXT, scanned_at TIMESTAMP(3),
 review_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(review_status IN ('PENDING','VERIFIED','REJECTED')),
 reviewed_by TEXT REFERENCES users(id), reviewed_at TIMESTAMP(3), source_name VARCHAR(200), reference VARCHAR(200), note VARCHAR(2000),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(branch_id,pharmacy_id) REFERENCES pharmacy_branches(id,pharmacy_id),
 CHECK ((kind='PREMISES_LICENCE') = (branch_id IS NOT NULL))
);
CREATE INDEX pharmacy_credentials_pharmacy_id_branch_id_kind_created_at_idx ON pharmacy_credentials(pharmacy_id,branch_id,kind,created_at);
CREATE INDEX pharmacy_credentials_scan_status_scan_lease_expires_at_idx ON pharmacy_credentials(scan_status,scan_lease_expires_at);
CREATE TABLE pharmacy_listings (
 id TEXT PRIMARY KEY, inventory_item_id TEXT NOT NULL UNIQUE REFERENCES pharmacy_inventory_items(id),
 category VARCHAR(40) NOT NULL, description VARCHAR(1500) NOT NULL,
 product_class VARCHAR(32) NOT NULL CHECK(product_class IN ('OTC','PRESCRIPTION_ONLY','NON_MEDICINAL')),
 nafdac_number VARCHAR(100), status VARCHAR(16) NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SUBMITTED','PUBLISHED','REJECTED','WITHDRAWN')),
 image_bytes BYTEA CHECK(octet_length(image_bytes) <= 1048576), image_hash CHAR(64),
 version INTEGER NOT NULL DEFAULT 1, reviewed_by TEXT REFERENCES users(id), reviewed_at TIMESTAMP(3), review_note VARCHAR(2000),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(status NOT IN ('SUBMITTED','PUBLISHED') OR (image_bytes IS NOT NULL AND image_hash IS NOT NULL)),
 CHECK(status <> 'PUBLISHED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
 CHECK(product_class <> 'PRESCRIPTION_ONLY' OR status <> 'PUBLISHED')
);
CREATE INDEX pharmacy_listings_status_created_at_idx ON pharmacy_listings(status,created_at);
ALTER TABLE order_fulfilments ADD COLUMN commission_bps INTEGER CHECK(commission_bps BETWEEN 0 AND 10000),
 ADD COLUMN commission_minor INTEGER CHECK(commission_minor >= 0), ADD COLUMN tier_version INTEGER;
-- OTC shopping uses the existing stock-hold/payment pipeline without creating
-- fictional prescriptions or doctor approvals.
ALTER TABLE reservations ALTER COLUMN prescription_id DROP NOT NULL,
 ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'PRESCRIPTION', ADD COLUMN request_hash CHAR(64),
 ADD CONSTRAINT reservation_kind_check CHECK ((kind='PRESCRIPTION' AND prescription_id IS NOT NULL) OR (kind='MARKETPLACE' AND prescription_id IS NULL AND request_hash IS NOT NULL));
ALTER TABLE reservation_allocations ALTER COLUMN prescription_item_id DROP NOT NULL,
 ALTER COLUMN quote_item_id DROP NOT NULL, ALTER COLUMN quote_revision DROP NOT NULL;
ALTER TABLE order_allocations ALTER COLUMN prescription_item_id DROP NOT NULL;
INSERT INTO access_permissions(code,description) VALUES
 ('platform.users.read','View account and organization directory without clinical data'),
 ('platform.users.manage','Suspend, disable, ban and restore eligible accounts'),
 ('platform.pharmacy.manage','Configure pharmacy tiers and review premises and listings') ON CONFLICT DO NOTHING;
INSERT INTO access_role_permissions(role_code,permission_code) VALUES
 ('SABI_PLATFORM_ADMIN','platform.users.read'),('SABI_PLATFORM_ADMIN','platform.users.manage'),('SABI_PLATFORM_ADMIN','platform.pharmacy.manage'),
 ('SABI_SECURITY_ADMIN','platform.users.read'),('SABI_SECURITY_ADMIN','platform.users.manage') ON CONFLICT DO NOTHING;
