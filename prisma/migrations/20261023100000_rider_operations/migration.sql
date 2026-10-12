ALTER TABLE delivery_partners
  ADD COLUMN is_available BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN available_until TIMESTAMP(3),
  ADD COLUMN availability_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN last_latitude DOUBLE PRECISION,
  ADD COLUMN last_longitude DOUBLE PRECISION,
  ADD COLUMN location_accuracy_meters DOUBLE PRECISION,
  ADD COLUMN location_updated_at TIMESTAMP(3);
ALTER TABLE delivery_partners ADD CONSTRAINT rider_presence_coordinates CHECK ((last_latitude IS NULL AND last_longitude IS NULL) OR (last_latitude BETWEEN -90 AND 90 AND last_longitude BETWEEN -180 AND 180));
ALTER TABLE delivery_assignments ADD COLUMN offer_expires_at TIMESTAMP(3), ADD COLUMN earning_offer_minor INTEGER, ADD COLUMN pay_policy_version INTEGER,
 ADD COLUMN pay_gross_minor INTEGER, ADD COLUMN pay_share_bps INTEGER, ADD COLUMN pay_retained_minor INTEGER;
ALTER TABLE delivery_assignments ADD CONSTRAINT delivery_pay_snapshot CHECK (
 (earning_offer_minor IS NULL AND pay_policy_version IS NULL AND pay_gross_minor IS NULL AND pay_share_bps IS NULL AND pay_retained_minor IS NULL)
 OR (earning_offer_minor IS NOT NULL AND pay_policy_version IS NOT NULL AND pay_gross_minor IS NOT NULL AND pay_share_bps IS NOT NULL AND pay_retained_minor IS NOT NULL AND earning_offer_minor > 0 AND pay_policy_version > 0 AND pay_gross_minor > 0 AND pay_retained_minor >= 0 AND pay_gross_minor = earning_offer_minor + pay_retained_minor AND pay_share_bps BETWEEN 1 AND 10000)
);
ALTER TABLE delivery_tracking_points ADD COLUMN accuracy_meters DOUBLE PRECISION;
CREATE TABLE rider_pay_policies (
 id TEXT PRIMARY KEY DEFAULT 'default', version INTEGER NOT NULL DEFAULT 1, published BOOLEAN NOT NULL DEFAULT FALSE,
 rider_share_bps INTEGER NOT NULL DEFAULT 8000, max_open_assignments INTEGER NOT NULL DEFAULT 1, max_pickup_km DOUBLE PRECISION NOT NULL DEFAULT 5,
 offer_expiry_minutes INTEGER NOT NULL DEFAULT 15 CHECK (offer_expiry_minutes BETWEEN 5 AND 60), automatic_dispatch BOOLEAN NOT NULL DEFAULT FALSE, updated_by_user_id TEXT REFERENCES users(id), updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT rider_rate_valid CHECK (version > 0 AND max_open_assignments BETWEEN 1 AND 10 AND max_pickup_km BETWEEN 0.1 AND 100 AND rider_share_bps BETWEEN 1 AND 10000)
);
INSERT INTO rider_pay_policies(id) VALUES ('default');
CREATE TABLE rider_bank_accounts (
 partner_id TEXT PRIMARY KEY REFERENCES delivery_partners(id), recipient_code TEXT NOT NULL, bank_code TEXT NOT NULL,
 bank_name TEXT NOT NULL, account_name TEXT NOT NULL, account_last4 VARCHAR(4) NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 verified_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE rider_earnings (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES delivery_partners(id), assignment_id TEXT NOT NULL UNIQUE REFERENCES delivery_assignments(id),
 amount_minor INTEGER NOT NULL CHECK (amount_minor > 0), policy_version INTEGER NOT NULL CHECK (policy_version > 0),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(partner_id,id)
);
CREATE INDEX rider_earnings_partner_date_idx ON rider_earnings(partner_id,created_at);
CREATE TABLE rider_payouts (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL REFERENCES delivery_partners(id), request_key TEXT NOT NULL,
 reference TEXT NOT NULL UNIQUE, amount_minor INTEGER NOT NULL CHECK (amount_minor > 0), currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
 bank_revision INTEGER NOT NULL, recipient_code TEXT NOT NULL, account_last4 VARCHAR(4) NOT NULL,
 status VARCHAR(30) NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','APPROVED','SUBMITTED','PAID','FAILED','REVERSED','NEEDS_PROVIDER_AUTH','UNKNOWN')),
 requested_by_user_id TEXT NOT NULL REFERENCES users(id), approved_by_user_id TEXT REFERENCES users(id), approved_at TIMESTAMP(3),
 submitted_at TIMESTAMP(3), paid_at TIMESTAMP(3), provider_transfer_code TEXT, provider_error_code TEXT, submit_lease_until TIMESTAMP(3),
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(partner_id,request_key), UNIQUE(partner_id,id),
 CONSTRAINT rider_payout_maker_checker CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id)
);
CREATE INDEX rider_payouts_status_date_idx ON rider_payouts(status,created_at);
CREATE TABLE rider_transfer_attempts (
 id TEXT PRIMARY KEY, payout_id TEXT NOT NULL REFERENCES rider_payouts(id), number INTEGER NOT NULL CHECK (number > 0),
 reference TEXT NOT NULL UNIQUE, status VARCHAR(30) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SUBMITTED','PAID','FAILED','REVERSED','NEEDS_PROVIDER_AUTH','UNKNOWN')),
 provider_transfer_code TEXT, error_code VARCHAR(80), lease_token TEXT, lease_until TIMESTAMP(3),
 next_check_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, verification_requested BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(payout_id,number)
);
CREATE INDEX rider_transfer_attempts_due_idx ON rider_transfer_attempts(status,next_check_at);
CREATE TABLE rider_payout_lines (
 id TEXT PRIMARY KEY, partner_id TEXT NOT NULL, payout_id TEXT NOT NULL, earning_id TEXT NOT NULL UNIQUE, UNIQUE(partner_id,earning_id),
 FOREIGN KEY(partner_id,payout_id) REFERENCES rider_payouts(partner_id,id),
 FOREIGN KEY(partner_id,earning_id) REFERENCES rider_earnings(partner_id,id)
);
CREATE TABLE delivery_exceptions (
 id TEXT PRIMARY KEY, assignment_id TEXT NOT NULL REFERENCES delivery_assignments(id), kind VARCHAR(40) NOT NULL,
 note VARCHAR(500) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
 resolution VARCHAR(40), resolution_note VARCHAR(500), reported_by_user_id TEXT NOT NULL REFERENCES users(id),
 resolved_by_user_id TEXT REFERENCES users(id), resolved_at TIMESTAMP(3), version INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX delivery_exceptions_status_date_idx ON delivery_exceptions(status,created_at);
CREATE UNIQUE INDEX delivery_exceptions_one_open ON delivery_exceptions(assignment_id) WHERE status = 'OPEN';
CREATE FUNCTION sabi_rider_earning_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Rider earnings and payout allocations are append-only'; END $$;
CREATE TRIGGER rider_earnings_immutable BEFORE UPDATE OR DELETE ON rider_earnings FOR EACH ROW EXECUTE FUNCTION sabi_rider_earning_immutable();
CREATE TRIGGER rider_payout_lines_immutable BEFORE UPDATE OR DELETE ON rider_payout_lines FOR EACH ROW EXECUTE FUNCTION sabi_rider_earning_immutable();
CREATE FUNCTION sabi_rider_money_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME = 'delivery_assignments' THEN
  IF (OLD.earning_offer_minor, OLD.pay_policy_version, OLD.pay_gross_minor, OLD.pay_share_bps, OLD.pay_retained_minor, OLD.partner_id, OLD.fulfilment_id) IS DISTINCT FROM (NEW.earning_offer_minor, NEW.pay_policy_version, NEW.pay_gross_minor, NEW.pay_share_bps, NEW.pay_retained_minor, NEW.partner_id, NEW.fulfilment_id) THEN RAISE EXCEPTION 'Delivery earning offer is immutable'; END IF;
 ELSIF TG_TABLE_NAME = 'rider_payouts' THEN
  IF (OLD.partner_id, OLD.amount_minor, OLD.currency, OLD.recipient_code, OLD.bank_revision, OLD.account_last4, OLD.reference, OLD.request_key, OLD.requested_by_user_id) IS DISTINCT FROM (NEW.partner_id, NEW.amount_minor, NEW.currency, NEW.recipient_code, NEW.bank_revision, NEW.account_last4, NEW.reference, NEW.request_key, NEW.requested_by_user_id) THEN RAISE EXCEPTION 'Payout financial snapshot is immutable'; END IF;
 ELSE
  IF (OLD.payout_id, OLD.number, OLD.reference) IS DISTINCT FROM (NEW.payout_id, NEW.number, NEW.reference) THEN RAISE EXCEPTION 'Transfer reference is immutable'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER delivery_pay_immutable BEFORE UPDATE ON delivery_assignments FOR EACH ROW EXECUTE FUNCTION sabi_rider_money_snapshot();
CREATE TRIGGER rider_payout_snapshot_immutable BEFORE UPDATE ON rider_payouts FOR EACH ROW EXECUTE FUNCTION sabi_rider_money_snapshot();
CREATE TRIGGER rider_transfer_snapshot_immutable BEFORE UPDATE ON rider_transfer_attempts FOR EACH ROW EXECUTE FUNCTION sabi_rider_money_snapshot();
