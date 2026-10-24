-- One-time, owner-approved bootstrap. Run through the IAM-authenticated
-- loopback Cloud SQL proxy as the official operator, never an API identity.
-- Does not create users, passwords, email verification or MFA enrolment.
\set ON_ERROR_STOP on
SELECT :'owner_bootstrap_confirm' = 'grant-first-production-owner' AS authorized \gset
\if :authorized
BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT pg_advisory_xact_lock(724102406);
DO $bootstrap$
DECLARE
  owner_id text;
BEGIN
  IF current_database() <> 'sabi_production'
     OR current_user <> 'damilare@sabihealth.org' THEN
    RAISE EXCEPTION 'Restricted production database/operator required';
  END IF;
  IF (SELECT count(*) FROM users WHERE lower(email) = 'sanusidamilare333@gmail.com') <> 1 THEN
    RAISE EXCEPTION 'Owner must first create exactly one Sabi account';
  END IF;
  SELECT id INTO owner_id FROM users
    WHERE lower(email) = 'sanusidamilare333@gmail.com'
      AND account_status = 'ACTIVE' AND email_verified_at IS NOT NULL
    FOR UPDATE;
  IF owner_id IS NULL THEN
    RAISE EXCEPTION 'Owner must verify email ownership before this grant';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM access_roles WHERE code = 'SABI_PLATFORM_ADMIN' AND scope = 'PLATFORM') THEN
    RAISE EXCEPTION 'Platform role migration missing';
  END IF;
  IF EXISTS (SELECT 1 FROM platform_role_assignments
      WHERE role_code IN ('SABI_PLATFORM_ADMIN', 'SABI_SUPER_ADMIN')
        AND user_id <> owner_id) THEN
    RAISE EXCEPTION 'Administrator already exists; use normal staff management';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform_role_assignments
      WHERE user_id = owner_id AND role_code = 'SABI_PLATFORM_ADMIN') THEN
    INSERT INTO platform_role_assignments (user_id, role_code)
      VALUES (owner_id, 'SABI_PLATFORM_ADMIN');
    INSERT INTO activity_logs (id, user_id, type, description, meta)
      VALUES (gen_random_uuid()::text, owner_id, 'PRODUCTION_OWNER_BOOTSTRAPPED',
        'First production platform owner assigned by authorized IAM operator',
        jsonb_build_object('roleCode', 'SABI_PLATFORM_ADMIN',
          'operator', current_user, 'database', current_database(),
          'emailOwnershipVerified', true, 'mfaRequired', true));
  END IF;
END
$bootstrap$;
COMMIT;
SELECT 'Production owner provisioned; existing email verification and MFA requirements remain enforced' AS result;
\else
\echo 'Explicit owner bootstrap confirmation required. Nothing changed.'
\quit 1
\endif
