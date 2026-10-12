CREATE TABLE platform_runtime_settings (
 id TEXT PRIMARY KEY DEFAULT 'default', version INTEGER NOT NULL DEFAULT 1,
 support_email TEXT NOT NULL DEFAULT 'support@sabihealth.org', info_email TEXT NOT NULL DEFAULT 'info@sabihealth.org',
 tracking_retention_days INTEGER NOT NULL DEFAULT 30 CHECK (tracking_retention_days BETWEEN 7 AND 90),
 updated_by_user_id TEXT REFERENCES users(id), updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO platform_runtime_settings(id) VALUES ('default');
CREATE TABLE tenant_presentations (
 organization_id TEXT PRIMARY KEY REFERENCES identity_organizations(id), version INTEGER NOT NULL DEFAULT 1,
 display_name VARCHAR(120) NOT NULL, tagline VARCHAR(180) NOT NULL DEFAULT '', accent_color VARCHAR(7) NOT NULL DEFAULT '#065f46',
 updated_by_user_id TEXT NOT NULL REFERENCES users(id), updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE subscription_invoices (
 id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES identity_organizations(id),
 application_id TEXT NOT NULL REFERENCES platform_applications(id), package_version_id TEXT NOT NULL REFERENCES platform_package_versions(id),
 package_name TEXT NOT NULL, cycle TEXT NOT NULL CHECK (cycle IN ('monthly','annual')), amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
 currency TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'), reference TEXT NOT NULL UNIQUE, request_key TEXT NOT NULL UNIQUE,
 period_start DATE NOT NULL, period_end DATE NOT NULL CHECK (period_end > period_start), due_at DATE NOT NULL,
 status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PAID','VOID')), created_by_user_id TEXT NOT NULL REFERENCES users(id),
 paid_at TIMESTAMP(3), voided_at TIMESTAMP(3), void_reason TEXT, created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX subscription_invoices_org_period_idx ON subscription_invoices(organization_id,period_start);
CREATE TABLE subscription_payments (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL UNIQUE REFERENCES subscription_invoices(id), reference TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','INITIALIZING','READY','UNKNOWN','PAID')),
 checkout_url TEXT, lease_token TEXT, lease_until TIMESTAMP(3), next_check_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 error_code TEXT, verified_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX subscription_payments_due_idx ON subscription_payments(status,next_check_at);
CREATE TABLE subscription_email_jobs (
 id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL REFERENCES subscription_invoices(id), kind TEXT NOT NULL, recipient TEXT NOT NULL,
 subject TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENDING','SENT','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TIMESTAMP(3), next_attempt_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 first_attempt_at TIMESTAMP(3), last_error_code TEXT, sent_at TIMESTAMP(3), created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(invoice_id,kind)
);
CREATE INDEX subscription_email_due_idx ON subscription_email_jobs(status,next_attempt_at);
CREATE FUNCTION sabi_subscription_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (OLD.organization_id,OLD.application_id,OLD.package_version_id,OLD.package_name,OLD.cycle,OLD.amount_minor,OLD.currency,OLD.reference,OLD.request_key,OLD.period_start,OLD.period_end,OLD.created_by_user_id) IS DISTINCT FROM (NEW.organization_id,NEW.application_id,NEW.package_version_id,NEW.package_name,NEW.cycle,NEW.amount_minor,NEW.currency,NEW.reference,NEW.request_key,NEW.period_start,NEW.period_end,NEW.created_by_user_id) THEN RAISE EXCEPTION 'Invoice snapshot is immutable'; END IF;
 IF OLD.status IN ('PAID','VOID') AND OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'Final invoice is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER subscription_invoice_immutable BEFORE UPDATE ON subscription_invoices FOR EACH ROW EXECUTE FUNCTION sabi_subscription_snapshot();
CREATE FUNCTION sabi_subscription_payment_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (OLD.invoice_id,OLD.reference) IS DISTINCT FROM (NEW.invoice_id,NEW.reference) OR (OLD.status = 'PAID' AND (NEW.status <> 'PAID' OR OLD.verified_at IS DISTINCT FROM NEW.verified_at)) THEN RAISE EXCEPTION 'Payment reference and verified receipt are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER subscription_payment_immutable BEFORE UPDATE ON subscription_payments FOR EACH ROW EXECUTE FUNCTION sabi_subscription_payment_snapshot();
INSERT INTO access_permissions(code,description) VALUES ('platform.settings.manage','Change platform settings and tenant presentation'), ('platform.subscriptions.manage','Issue and void Sabi OS subscription invoices') ON CONFLICT DO NOTHING;
INSERT INTO access_role_permissions(role_code,permission_code) VALUES
 ('SABI_SUPER_ADMIN','platform.settings.manage'),('SABI_PLATFORM_ADMIN','platform.settings.manage'),
 ('SABI_SUPER_ADMIN','platform.subscriptions.manage'),('SABI_PLATFORM_ADMIN','platform.subscriptions.manage'),('SABI_FINANCE','platform.subscriptions.manage') ON CONFLICT DO NOTHING;
