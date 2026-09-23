-- Additive identity foundation. Existing users, organisations, pharmacies,
-- legacy roles and patient/commerce records remain in place.
CREATE TYPE "UserAccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'LOCKED', 'DISABLED', 'DEACTIVATED');
CREATE TYPE "IdentityOrganizationType" AS ENUM ('HOSPITAL', 'CLINIC', 'LABORATORY', 'DIAGNOSTIC_CENTRE', 'PHARMACY', 'OTHER');
CREATE TYPE "IdentityMembershipStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED');
CREATE TYPE "AccessRoleScope" AS ENUM ('ORGANIZATION', 'PLATFORM');

ALTER TABLE "users"
  ADD COLUMN "account_status" "UserAccountStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN "email_verified_at" TIMESTAMP(3),
  ADD COLUMN "phone_verified_at" TIMESTAMP(3),
  ADD COLUMN "last_login_at" TIMESTAMP(3);

CREATE TABLE "identity_organizations" (
  "id" TEXT NOT NULL,
  "type" "IdentityOrganizationType" NOT NULL,
  "organisation_id" TEXT,
  "pharmacy_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "identity_organizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "identity_organizations_one_facility_chk" CHECK (
    ("organisation_id" IS NOT NULL AND "pharmacy_id" IS NULL AND "type" <> 'PHARMACY')
    OR ("organisation_id" IS NULL AND "pharmacy_id" IS NOT NULL AND "type" = 'PHARMACY')
  )
);
CREATE UNIQUE INDEX "identity_organizations_organisation_id_key" ON "identity_organizations"("organisation_id");
CREATE UNIQUE INDEX "identity_organizations_pharmacy_id_key" ON "identity_organizations"("pharmacy_id");
ALTER TABLE "identity_organizations" ADD CONSTRAINT "identity_organizations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "identity_organizations" ADD CONSTRAINT "identity_organizations_pharmacy_id_fkey" FOREIGN KEY ("pharmacy_id") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "access_roles" (
  "code" TEXT NOT NULL,
  "scope" "AccessRoleScope" NOT NULL,
  "description" TEXT,
  CONSTRAINT "access_roles_pkey" PRIMARY KEY ("code")
);
CREATE TABLE "access_permissions" (
  "code" TEXT NOT NULL,
  "description" TEXT,
  CONSTRAINT "access_permissions_pkey" PRIMARY KEY ("code")
);
CREATE TABLE "access_role_permissions" (
  "role_code" TEXT NOT NULL,
  "permission_code" TEXT NOT NULL,
  CONSTRAINT "access_role_permissions_pkey" PRIMARY KEY ("role_code", "permission_code")
);
ALTER TABLE "access_role_permissions" ADD CONSTRAINT "access_role_permissions_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "access_roles"("code") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "access_role_permissions" ADD CONSTRAINT "access_role_permissions_permission_code_fkey" FOREIGN KEY ("permission_code") REFERENCES "access_permissions"("code") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "organization_memberships" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "status" "IdentityMembershipStatus" NOT NULL DEFAULT 'PENDING',
  "joined_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "organization_memberships_user_id_organization_id_key" ON "organization_memberships"("user_id", "organization_id");
CREATE INDEX "organization_memberships_organization_id_status_idx" ON "organization_memberships"("organization_id", "status");
CREATE INDEX "organization_memberships_user_id_status_idx" ON "organization_memberships"("user_id", "status");
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "membership_roles" (
  "membership_id" TEXT NOT NULL,
  "role_code" TEXT NOT NULL,
  CONSTRAINT "membership_roles_pkey" PRIMARY KEY ("membership_id", "role_code")
);
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "organization_memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "membership_roles" ADD CONSTRAINT "membership_roles_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "access_roles"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "platform_role_assignments" (
  "user_id" TEXT NOT NULL,
  "role_code" TEXT NOT NULL,
  CONSTRAINT "platform_role_assignments_pkey" PRIMARY KEY ("user_id", "role_code")
);
ALTER TABLE "platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "platform_role_assignments" ADD CONSTRAINT "platform_role_assignments_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "access_roles"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A platform role cannot be attached to a tenant membership and vice versa.
CREATE FUNCTION "enforce_identity_role_scope"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "access_roles"
    WHERE "code" = NEW."role_code" AND "scope" = TG_ARGV[0]::"AccessRoleScope"
  ) THEN
    RAISE EXCEPTION 'Role scope mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "membership_roles_scope_trg" BEFORE INSERT OR UPDATE ON "membership_roles"
  FOR EACH ROW EXECUTE FUNCTION "enforce_identity_role_scope"('ORGANIZATION');
CREATE TRIGGER "platform_role_assignments_scope_trg" BEFORE INSERT OR UPDATE ON "platform_role_assignments"
  FOR EACH ROW EXECUTE FUNCTION "enforce_identity_role_scope"('PLATFORM');

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('organization.read', 'Read own organization settings'),
  ('organization.manage', 'Manage own organization settings'),
  ('membership.read', 'Read own organization members'),
  ('membership.manage', 'Manage own organization memberships'),
  ('patient.read', 'Read an authorized patient'),
  ('patient.update', 'Update an authorized patient'),
  ('clinical.consultation.create', 'Create an authorized consultation'),
  ('prescription.create', 'Create an authorized prescription'),
  ('prescription.dispense', 'Dispense an authorized prescription'),
  ('lab.order.create', 'Create a laboratory order'),
  ('lab.result.create', 'Create a laboratory result'),
  ('invoice.create', 'Create an invoice'),
  ('invoice.approve', 'Approve an invoice'),
  ('payment.record', 'Record a verified payment'),
  ('inventory.view', 'View own organization inventory'),
  ('inventory.adjust', 'Adjust own organization inventory'),
  ('employee.create', 'Add an employee'),
  ('employee.update', 'Update an employee'),
  ('audit.view', 'View own organization audit'),
  ('pharmacy.manage', 'Manage own pharmacy'),
  ('platform.catalog.manage', 'Manage published product catalogue'),
  ('platform.onboarding.review', 'Review onboarding applications'),
  ('platform.security.view', 'View platform security events'),
  ('platform.support.access', 'Request scoped support access')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_roles" ("code", "scope", "description") VALUES
  ('ORGANISATION_OWNER', 'ORGANIZATION', 'Healthcare organization owner'),
  ('HOSPITAL_ADMIN', 'ORGANIZATION', 'Hospital administrator'),
  ('DOCTOR', 'ORGANIZATION', 'Clinician'),
  ('NURSE', 'ORGANIZATION', 'Nursing professional'),
  ('PHARMACY_ADMIN', 'ORGANIZATION', 'Pharmacy administrator'),
  ('PHARMACIST', 'ORGANIZATION', 'Dispensing pharmacist'),
  ('PHARMACY_STAFF', 'ORGANIZATION', 'Pharmacy operations staff'),
  ('LAB_SCIENTIST', 'ORGANIZATION', 'Laboratory professional'),
  ('FINANCE_OFFICER', 'ORGANIZATION', 'Finance officer'),
  ('INVENTORY_OFFICER', 'ORGANIZATION', 'Inventory officer'),
  ('HR_OFFICER', 'ORGANIZATION', 'Human resources officer'),
  ('RECEPTIONIST', 'ORGANIZATION', 'Reception staff'),
  ('SABI_SUPER_ADMIN', 'PLATFORM', 'Sabi super administrator'),
  ('SABI_PLATFORM_ADMIN', 'PLATFORM', 'Sabi platform administrator'),
  ('SABI_SUPPORT', 'PLATFORM', 'Sabi support operator'),
  ('SABI_COMPLIANCE', 'PLATFORM', 'Sabi compliance reviewer'),
  ('SABI_SECURITY_ADMIN', 'PLATFORM', 'Sabi security administrator'),
  ('SABI_PHARMACY_COMPLIANCE', 'PLATFORM', 'Sabi pharmacy compliance reviewer')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('ORGANISATION_OWNER', 'organization.read'),
  ('ORGANISATION_OWNER', 'organization.manage'),
  ('ORGANISATION_OWNER', 'membership.read'),
  ('ORGANISATION_OWNER', 'membership.manage'),
  ('ORGANISATION_OWNER', 'employee.create'),
  ('ORGANISATION_OWNER', 'employee.update'),
  ('HOSPITAL_ADMIN', 'organization.read'),
  ('HOSPITAL_ADMIN', 'membership.read'),
  ('HOSPITAL_ADMIN', 'membership.manage'),
  ('HOSPITAL_ADMIN', 'employee.create'),
  ('HOSPITAL_ADMIN', 'employee.update'),
  ('DOCTOR', 'patient.read'),
  ('DOCTOR', 'patient.update'),
  ('DOCTOR', 'clinical.consultation.create'),
  ('DOCTOR', 'prescription.create'),
  ('DOCTOR', 'lab.order.create'),
  ('NURSE', 'patient.read'),
  ('NURSE', 'patient.update'),
  ('LAB_SCIENTIST', 'lab.result.create'),
  ('PHARMACY_ADMIN', 'organization.read'),
  ('PHARMACY_ADMIN', 'membership.read'),
  ('PHARMACY_ADMIN', 'membership.manage'),
  ('PHARMACY_ADMIN', 'pharmacy.manage'),
  ('PHARMACY_ADMIN', 'inventory.view'),
  ('PHARMACY_ADMIN', 'inventory.adjust'),
  ('PHARMACIST', 'inventory.view'),
  ('PHARMACIST', 'prescription.dispense'),
  ('PHARMACY_STAFF', 'inventory.view'),
  ('FINANCE_OFFICER', 'invoice.create'),
  ('FINANCE_OFFICER', 'invoice.approve'),
  ('FINANCE_OFFICER', 'payment.record'),
  ('INVENTORY_OFFICER', 'inventory.view'),
  ('INVENTORY_OFFICER', 'inventory.adjust'),
  ('HR_OFFICER', 'employee.create'),
  ('HR_OFFICER', 'employee.update'),
  ('RECEPTIONIST', 'organization.read'),
  ('SABI_SUPER_ADMIN', 'platform.catalog.manage'),
  ('SABI_SUPER_ADMIN', 'platform.onboarding.review'),
  ('SABI_SUPER_ADMIN', 'platform.security.view'),
  ('SABI_PLATFORM_ADMIN', 'platform.catalog.manage'),
  ('SABI_PLATFORM_ADMIN', 'platform.onboarding.review'),
  ('SABI_SUPPORT', 'platform.support.access'),
  ('SABI_COMPLIANCE', 'platform.onboarding.review'),
  ('SABI_SECURITY_ADMIN', 'platform.security.view'),
  ('SABI_PHARMACY_COMPLIANCE', 'platform.onboarding.review')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;

-- Link existing facilities; keep their original IDs and lifecycle state.
INSERT INTO "identity_organizations" ("id", "type", "organisation_id")
SELECT gen_random_uuid()::text, o."type"::text::"IdentityOrganizationType", o."id"
FROM "organisations" o
ON CONFLICT ("organisation_id") DO NOTHING;
INSERT INTO "identity_organizations" ("id", "type", "pharmacy_id")
SELECT gen_random_uuid()::text, 'PHARMACY', p."id"
FROM "pharmacies" p
ON CONFLICT ("pharmacy_id") DO NOTHING;

INSERT INTO "organization_memberships" ("id", "user_id", "organization_id", "status", "joined_at")
SELECT gen_random_uuid()::text, o."owner_id", io."id", 'ACTIVE', o."created_at"
FROM "organisations" o JOIN "identity_organizations" io ON io."organisation_id" = o."id"
ON CONFLICT ("user_id", "organization_id") DO NOTHING;
INSERT INTO "membership_roles" ("membership_id", "role_code")
SELECT m."id", 'ORGANISATION_OWNER'
FROM "organization_memberships" m JOIN "identity_organizations" io ON io."id" = m."organization_id"
JOIN "organisations" o ON o."id" = io."organisation_id" AND o."owner_id" = m."user_id"
ON CONFLICT DO NOTHING;

INSERT INTO "organization_memberships" ("id", "user_id", "organization_id", "status", "joined_at")
SELECT gen_random_uuid()::text, p."admin_user_id", io."id", 'ACTIVE', p."created_at"
FROM "pharmacies" p JOIN "identity_organizations" io ON io."pharmacy_id" = p."id"
ON CONFLICT ("user_id", "organization_id") DO NOTHING;
INSERT INTO "membership_roles" ("membership_id", "role_code")
SELECT m."id", 'PHARMACY_ADMIN'
FROM "organization_memberships" m JOIN "identity_organizations" io ON io."id" = m."organization_id"
JOIN "pharmacies" p ON p."id" = io."pharmacy_id" AND p."admin_user_id" = m."user_id"
ON CONFLICT DO NOTHING;

INSERT INTO "organization_memberships" ("id", "user_id", "organization_id", "status", "joined_at")
SELECT gen_random_uuid()::text, s."pharmacist_user_id", io."id",
  CASE WHEN s."status" = 'ACTIVE' THEN 'ACTIVE'::"IdentityMembershipStatus"
       WHEN s."status" = 'PENDING' THEN 'PENDING'::"IdentityMembershipStatus"
       ELSE 'REVOKED'::"IdentityMembershipStatus" END,
  s."accepted_at"
FROM "pharmacy_staff_members" s
JOIN "identity_organizations" io ON io."pharmacy_id" = s."pharmacy_id"
ON CONFLICT ("user_id", "organization_id") DO NOTHING;
INSERT INTO "membership_roles" ("membership_id", "role_code")
SELECT m."id", 'PHARMACIST'
FROM "organization_memberships" m
JOIN "identity_organizations" io ON io."id" = m."organization_id"
JOIN "pharmacy_staff_members" s ON s."pharmacy_id" = io."pharmacy_id" AND s."pharmacist_user_id" = m."user_id"
ON CONFLICT DO NOTHING;

INSERT INTO "platform_role_assignments" ("user_id", "role_code")
SELECT "user_id", 'SABI_SUPER_ADMIN' FROM "user_roles" WHERE "role" = 'SUPER_ADMIN'
ON CONFLICT DO NOTHING;
INSERT INTO "platform_role_assignments" ("user_id", "role_code")
SELECT "user_id", 'SABI_PHARMACY_COMPLIANCE' FROM "user_roles" WHERE "role" = 'PHARMACY_COMPLIANCE_ADMIN'
ON CONFLICT DO NOTHING;
