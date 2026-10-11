-- Command Centre foundations: least-privilege platform roles and permissions, and an append-only
-- audit trail. See docs/command-centre (frontend repo) for the gap matrix this implements.

-- ---------------------------------------------------------------------------------------------
-- Permissions. Clinical content is separate from account-level patient data, and finance is
-- split into read / manage / approve so high-impact money actions can need a second person.
-- ---------------------------------------------------------------------------------------------
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('platform.ops.read', 'See operational dashboards, orders, deliveries, consultations and provider status (no clinical content)'),
  ('platform.patients.read', 'Open a patient''s account profile: identity, status, sessions, care circle, orders and payments'),
  ('platform.clinical.read', 'Open clinical sections of a patient profile (medicines, allergies, conditions, lab) with a stated purpose'),
  ('platform.emergency.access', 'Request time-limited emergency access to restricted clinical records'),
  ('platform.pricing.manage', 'Change delivery pricing and other commercial rules'),
  ('platform.finance.read', 'See transactions, commissions, refunds, settlements and reconciliation'),
  ('platform.finance.manage', 'Request refunds and prepare settlements'),
  ('platform.finance.approve', 'Approve refunds and settlements prepared by someone else'),
  ('platform.support.manage', 'Open, assign and resolve support cases and incidents'),
  ('platform.delivery.manage', 'Assign and reassign deliveries and manage riders'),
  ('platform.providers.manage', 'Suspend, restrict and reactivate providers with a recorded reason'),
  ('platform.jobs.manage', 'Retry failed notifications and background jobs'),
  ('platform.audit.read', 'Read the platform audit trail and access history')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_roles" ("code", "scope", "description") VALUES
  ('SABI_OPERATIONS', 'PLATFORM', 'Sabi operations (orders, deliveries, consultations, providers)'),
  ('SABI_FINANCE', 'PLATFORM', 'Sabi finance (payments, refunds, settlements, reconciliation)'),
  ('SABI_CLINICAL_OVERSIGHT', 'PLATFORM', 'Sabi clinical oversight (clinical record review with stated purpose)')
ON CONFLICT ("code") DO NOTHING;

-- Super admin holds every platform permission.
INSERT INTO "access_role_permissions" ("role_code", "permission_code")
SELECT 'SABI_SUPER_ADMIN', "code" FROM "access_permissions" WHERE "code" LIKE 'platform.%'
ON CONFLICT ("role_code", "permission_code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('SABI_PLATFORM_ADMIN', 'platform.ops.read'),
  ('SABI_PLATFORM_ADMIN', 'platform.patients.read'),
  ('SABI_PLATFORM_ADMIN', 'platform.pricing.manage'),
  ('SABI_PLATFORM_ADMIN', 'platform.providers.manage'),
  ('SABI_PLATFORM_ADMIN', 'platform.delivery.manage'),
  ('SABI_PLATFORM_ADMIN', 'platform.support.manage'),
  ('SABI_PLATFORM_ADMIN', 'platform.jobs.manage'),
  ('SABI_PLATFORM_ADMIN', 'platform.audit.read'),
  ('SABI_PLATFORM_ADMIN', 'platform.finance.read'),
  ('SABI_OPERATIONS', 'platform.ops.read'),
  ('SABI_OPERATIONS', 'platform.patients.read'),
  ('SABI_OPERATIONS', 'platform.delivery.manage'),
  ('SABI_OPERATIONS', 'platform.support.manage'),
  ('SABI_OPERATIONS', 'platform.jobs.manage'),
  ('SABI_OPERATIONS', 'platform.users.read'),
  ('SABI_SUPPORT', 'platform.ops.read'),
  ('SABI_SUPPORT', 'platform.patients.read'),
  ('SABI_SUPPORT', 'platform.support.manage'),
  ('SABI_FINANCE', 'platform.ops.read'),
  ('SABI_FINANCE', 'platform.finance.read'),
  ('SABI_FINANCE', 'platform.finance.manage'),
  ('SABI_FINANCE', 'platform.finance.approve'),
  ('SABI_CLINICAL_OVERSIGHT', 'platform.ops.read'),
  ('SABI_CLINICAL_OVERSIGHT', 'platform.patients.read'),
  ('SABI_CLINICAL_OVERSIGHT', 'platform.clinical.read'),
  ('SABI_CLINICAL_OVERSIGHT', 'platform.emergency.access'),
  ('SABI_COMPLIANCE', 'platform.ops.read'),
  ('SABI_COMPLIANCE', 'platform.providers.manage'),
  ('SABI_COMPLIANCE', 'platform.audit.read'),
  ('SABI_PHARMACY_COMPLIANCE', 'platform.ops.read'),
  ('SABI_SECURITY_ADMIN', 'platform.ops.read'),
  ('SABI_SECURITY_ADMIN', 'platform.audit.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- Audit trail (already append-only via "audit_events_no_change"): a category for Sabi staff
-- actions, and indexes for per-record access history and category feeds.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_category_check";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_category_check"
  CHECK ("category" IN ('SIGN_IN', 'RECORD_ACCESS', 'RECORD_CHANGE', 'PERMISSION', 'ACCOUNT', 'ACTIVITY', 'ADMIN'));

CREATE INDEX IF NOT EXISTS "audit_events_resource_type_resource_id_created_at_idx"
  ON "audit_events" ("resource_type", "resource_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_events_category_created_at_idx" ON "audit_events" ("category", "created_at" DESC);
