-- EMR foundation: tenant isolation (row-level security), append-only audit, idempotency,
-- transactional outbox + webhooks, and versioned patient records. See docs/emr-backend.md.
-- Every EMR table carries organization_id; every key, foreign key and index leads with it.

-- ---------------------------------------------------------------------------------------------
-- 1. Restricted application role. EMR requests run `SET LOCAL ROLE sabi_emr_app` inside their
--    transaction, so row-level security applies even when the connecting role would bypass it.
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sabi_emr_app') THEN
    CREATE ROLE sabi_emr_app NOLOGIN NOBYPASSRLS;
  END IF;
END $$;
GRANT sabi_emr_app TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO sabi_emr_app;

-- Current tenant for the transaction; NULL (matches nothing) when unset.
CREATE OR REPLACE FUNCTION emr_current_organization() RETURNS text
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.organization_id', true), '') $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Patients: fuller demographics, lifecycle, optimistic concurrency, account link.
-- ---------------------------------------------------------------------------------------------
CREATE TYPE "EmrPatientStatus" AS ENUM ('ACTIVE', 'INACTIVE');

ALTER TABLE "emr_patients"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "status" "EmrPatientStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "other_names" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "email" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "state" TEXT,
  ADD COLUMN "lga" TEXT,
  ADD COLUMN "national_id" TEXT,
  ADD COLUMN "next_of_kin_name" TEXT,
  ADD COLUMN "next_of_kin_phone" TEXT,
  ADD COLUMN "next_of_kin_relationship" TEXT,
  ADD COLUMN "consent_to_contact" BOOLEAN,
  ADD COLUMN "linked_user_id" TEXT,
  ADD COLUMN "deactivated_at" TIMESTAMP(3),
  ADD COLUMN "deactivation_reason" TEXT,
  ADD COLUMN "updated_by_user_id" TEXT;

-- Composite key target so other EMR tables can reference (organization_id, patient id): a row
-- can then never point at another tenant's patient, whatever the application does.
CREATE UNIQUE INDEX "emr_patients_organization_id_id_key" ON "emr_patients"("organization_id", "id");
CREATE UNIQUE INDEX "emr_patients_organization_id_national_id_key"
  ON "emr_patients"("organization_id", "national_id") WHERE "national_id" IS NOT NULL;
CREATE UNIQUE INDEX "emr_patients_organization_id_linked_user_id_key"
  ON "emr_patients"("organization_id", "linked_user_id") WHERE "linked_user_id" IS NOT NULL;
-- Name search within a tenant (prefix/contains on lower-cased names).
CREATE INDEX "emr_patients_organization_id_family_name_idx" ON "emr_patients"("organization_id", lower("family_name"), lower("given_name"));
ALTER TABLE "emr_patients" ADD CONSTRAINT "emr_patients_linked_user_id_fkey"
  FOREIGN KEY ("linked_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 3. Append-only audit (HIPAA): who did what to which record. Field names only, never values.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_audit_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "actor_user_id" TEXT,
  "action" TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" TEXT,
  "request_id" TEXT,
  "changed_fields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_audit_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "emr_audit_events_organization_id_created_at_idx" ON "emr_audit_events"("organization_id", "created_at" DESC, "id");
CREATE INDEX "emr_audit_events_organization_id_resource_idx" ON "emr_audit_events"("organization_id", "resource_type", "resource_id", "created_at" DESC);

CREATE OR REPLACE FUNCTION emr_audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'emr_audit_events is append-only';
END $$;
CREATE TRIGGER "emr_audit_events_no_update" BEFORE UPDATE OR DELETE ON "emr_audit_events"
  FOR EACH ROW EXECUTE FUNCTION emr_audit_events_append_only();

-- ---------------------------------------------------------------------------------------------
-- 4. Idempotency keys for critical creates (retained 24 h, purged by the worker).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_idempotency_keys" (
  "organization_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "status_code" INTEGER,
  "response_body" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_idempotency_keys_pkey" PRIMARY KEY ("organization_id", "scope", "idempotency_key"),
  CONSTRAINT "emr_idempotency_keys_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "emr_idempotency_keys_created_at_idx" ON "emr_idempotency_keys"("created_at");

-- ---------------------------------------------------------------------------------------------
-- 5. Transactional outbox + webhook subscriptions + per-subscriber deliveries.
--    Payloads carry identifiers and codes only (no PHI).
-- ---------------------------------------------------------------------------------------------
CREATE TYPE "EmrOutboxStatus" AS ENUM ('PENDING', 'DISPATCHED');
CREATE TYPE "EmrDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'DEAD');

CREATE TABLE "emr_outbox_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "aggregate_type" TEXT NOT NULL,
  "aggregate_id" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "EmrOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatched_at" TIMESTAMP(3),
  CONSTRAINT "emr_outbox_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_outbox_events_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_outbox_events_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "emr_outbox_events_pending_idx" ON "emr_outbox_events"("created_at") WHERE "status" = 'PENDING';

CREATE TABLE "emr_webhook_subscriptions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "secret_ciphertext" TEXT NOT NULL,
  "event_types" TEXT[] NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_webhook_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_webhook_subscriptions_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_webhook_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "emr_webhook_subscriptions_organization_id_active_idx" ON "emr_webhook_subscriptions"("organization_id", "active");

CREATE TABLE "emr_webhook_deliveries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "subscription_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "status" "EmrDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_status_code" INTEGER,
  "last_error" TEXT,
  "delivered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_webhook_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_webhook_deliveries_subscription_event_key" UNIQUE ("organization_id", "subscription_id", "event_id"),
  CONSTRAINT "emr_webhook_deliveries_subscription_fkey" FOREIGN KEY ("organization_id", "subscription_id") REFERENCES "emr_webhook_subscriptions"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "emr_webhook_deliveries_event_fkey" FOREIGN KEY ("organization_id", "event_id") REFERENCES "emr_outbox_events"("organization_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "emr_webhook_deliveries_due_idx" ON "emr_webhook_deliveries"("next_attempt_at") WHERE "status" = 'PENDING';

-- ---------------------------------------------------------------------------------------------
-- 6. Row-level security. Clinical tables: strictly the current tenant. Outbox/webhook tables
--    additionally allow the delivery worker's system context (no clinical data lives there).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "emr_patients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_patients" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_patients_tenant" ON "emr_patients"
  USING ("organization_id" = emr_current_organization())
  WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_audit_events_tenant" ON "emr_audit_events"
  USING ("organization_id" = emr_current_organization())
  WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_idempotency_keys" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_idempotency_keys" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_idempotency_keys_tenant" ON "emr_idempotency_keys"
  USING ("organization_id" = emr_current_organization() OR current_setting('app.system_context', true) = 'emr-worker')
  WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_outbox_events_tenant" ON "emr_outbox_events"
  USING ("organization_id" = emr_current_organization() OR current_setting('app.system_context', true) = 'emr-worker')
  WITH CHECK ("organization_id" = emr_current_organization() OR current_setting('app.system_context', true) = 'emr-worker');

ALTER TABLE "emr_webhook_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_webhook_subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_webhook_subscriptions_tenant" ON "emr_webhook_subscriptions"
  USING ("organization_id" = emr_current_organization() OR current_setting('app.system_context', true) = 'emr-worker')
  WITH CHECK ("organization_id" = emr_current_organization());

ALTER TABLE "emr_webhook_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_webhook_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_webhook_deliveries_tenant" ON "emr_webhook_deliveries"
  USING ("organization_id" = emr_current_organization() OR current_setting('app.system_context', true) = 'emr-worker')
  WITH CHECK ("organization_id" = emr_current_organization() OR current_setting('app.system_context', true) = 'emr-worker');

-- ---------------------------------------------------------------------------------------------
-- 7. Grants for the restricted role (least privilege: no DELETE on clinical or audit data).
-- ---------------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON "emr_patients" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_audit_events" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "emr_idempotency_keys" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_outbox_events" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_webhook_subscriptions" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_webhook_deliveries" TO sabi_emr_app;
-- Names of the people who recorded things (no other user columns).
GRANT SELECT ("id", "full_name") ON "users" TO sabi_emr_app;

-- ---------------------------------------------------------------------------------------------
-- 8. Permissions.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('patient.deactivate', 'Deactivate a patient record (records are retained)'),
  ('emr.webhook.manage', 'Manage the organization''s EMR webhook subscriptions')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HOSPITAL_ADMIN', 'patient.update'),
  ('HOSPITAL_ADMIN', 'patient.deactivate'),
  ('HOSPITAL_ADMIN', 'emr.webhook.manage'),
  ('HOSPITAL_ADMIN', 'audit.view'),
  ('ORGANISATION_OWNER', 'audit.view'),
  ('ORGANISATION_OWNER', 'emr.webhook.manage'),
  ('RECEPTIONIST', 'patient.update')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
