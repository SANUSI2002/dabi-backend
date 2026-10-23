-- Apply as the migration identity, against sabi_production, after migrations.
-- Deliberately no default privileges: new tables require a reviewed deployment.
-- Service identities remain non-owners; end users never receive SQL logins.
BEGIN;
DO $bootstrap$
DECLARE identity_name text;
BEGIN
  FOREACH identity_name IN ARRAY ARRAY[
    'sabi-api-production@project-2dfff4eb-ff04-40b1-aff.iam',
    'sabi-worker-production@project-2dfff4eb-ff04-40b1-aff.iam'
  ] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=identity_name AND NOT
      (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)) THEN
      RAISE EXCEPTION 'Missing or overprivileged runtime identity: %', identity_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='sabi_application_server') THEN
    CREATE ROLE sabi_application_server NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname='sabi_application_server' AND
    (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Application group has unsafe attributes';
  END IF;
END $bootstrap$;

-- Never inherit the EMR group's table privileges into the global Prisma client.
-- withTenant()/withWorker() explicitly SET LOCAL ROLE and set transaction context.
GRANT sabi_emr_app TO
  "sabi-api-production@project-2dfff4eb-ff04-40b1-aff.iam",
  "sabi-worker-production@project-2dfff4eb-ff04-40b1-aff.iam" WITH INHERIT FALSE;
GRANT sabi_emr_app TO
  "sabi-api-production@project-2dfff4eb-ff04-40b1-aff.iam",
  "sabi-worker-production@project-2dfff4eb-ff04-40b1-aff.iam" WITH SET TRUE;
GRANT sabi_emr_app TO
  "sabi-api-production@project-2dfff4eb-ff04-40b1-aff.iam",
  "sabi-worker-production@project-2dfff4eb-ff04-40b1-aff.iam" WITH ADMIN FALSE;
GRANT sabi_application_server TO
  "sabi-api-production@project-2dfff4eb-ff04-40b1-aff.iam",
  "sabi-worker-production@project-2dfff4eb-ff04-40b1-aff.iam" WITH INHERIT TRUE;
GRANT sabi_application_server TO
  "sabi-api-production@project-2dfff4eb-ff04-40b1-aff.iam",
  "sabi-worker-production@project-2dfff4eb-ff04-40b1-aff.iam" WITH ADMIN FALSE;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO sabi_application_server;

DO $tables$
DECLARE table_name text;
  application_tables text[] := ARRAY[
    'Appointment','DoctorApplication','DoctorCredential','Medication',
    'ProfessionalCareConsent','ProfessionalCareFeedback','ProfessionalCareNote',
    'ProfessionalCarePlan','ProfessionalCareTemplate','ProfessionalCareVersion',
    'ProfessionalSchedule','ProfessionalTimeBlock','Vital',
    'access_permissions','access_role_permissions','access_roles','activity_logs',
    'audit_events','auth_devices','auth_refresh_credentials','auth_sessions',
    'care_relationships','caregiver_profiles','checkout_pricing_configurations',
    'consultation_note_versions','consultation_notes','delivery_assignments',
    'delivery_exceptions','delivery_partners','delivery_tracking_points',
    'dependent_profiles','doctor_appointments','doctor_availability_slots',
    'doctor_care_relationships','doctor_video_rooms','domain_events',
    'email_verification_tokens','emergency_access_grants','emr_telehealth_handoffs',
    'family_members','health_metrics','hospital_appointments','hospital_enrollments',
    'hospital_member_plans','identity_invitations','identity_organizations',
    'medical_document_scan_results','medical_document_shares','medical_documents',
    'medical_records','medication_doses','medication_schedules','membership_roles',
    'mfa_login_challenges','mfa_recovery_codes','mfa_totp','notification_deliveries',
    'notification_preferences','notifications','ops_case_events','ops_cases',
    'order_allocations','order_fulfilments','orders','organisation_documents',
    'organisation_submissions','organisations','organization_memberships',
    'password_reset_tokens','payment_attempt_events','payment_attempts',
    'payment_webhook_receipts','pharmacies','pharmacy_branches','pharmacy_credentials',
    'pharmacy_email_jobs','pharmacy_inventory_items','pharmacy_listings',
    'pharmacy_quote_items','pharmacy_quotes','pharmacy_settlement_items',
    'pharmacy_settlements','pharmacy_staff_members','pharmacy_stock_adjustments',
    'pharmacy_tiers','platform_application_evidence','platform_application_evidence_events',
    'platform_application_review_notes','platform_applications','platform_package_versions',
    'platform_packages','platform_role_assignments','platform_runtime_settings',
    'prescription_items','prescription_requests','prescriptions','professional_profiles',
    'push_subscriptions','record_categories','refresh_tokens','refund_review_cases',
    'reminder_jobs','reservation_allocations','reservations','rider_applications',
    'rider_bank_accounts','rider_credentials','rider_earnings','rider_mail_jobs',
    'rider_pay_policies','rider_payout_lines','rider_payouts','rider_transfer_attempts',
    'subscription_email_jobs','subscription_invoices','subscription_payments',
    'tenant_presentations','user_identity_providers','user_profiles','user_roles',
    'users','waitlist_signups','wellness_bookings','wellness_offerings',
    'wellness_providers','whatsapp_connections','whatsapp_webhook_events'
  ];
  immutable_tables text[] := ARRAY['audit_events','consultation_note_versions',
    'ops_case_events','ProfessionalCareNote','ProfessionalCareVersion',
    'rider_earnings','rider_payout_lines'];
BEGIN
  FOREACH table_name IN ARRAY application_tables LOOP
    IF NOT EXISTS (SELECT FROM pg_class WHERE oid=to_regclass(format('public.%I',table_name))
      AND relkind='r' AND NOT relrowsecurity) THEN
      RAISE EXCEPTION 'Missing or unexpectedly RLS-protected application table: %', table_name;
    END IF;
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO sabi_application_server',table_name);
    IF NOT table_name=ANY(immutable_tables) THEN
      EXECUTE format('GRANT UPDATE, DELETE ON TABLE public.%I TO sabi_application_server',table_name);
    END IF;
  END LOOP;
END $tables$;

-- These AI tables previously relied on an owner connection. Replace that implicit
-- owner bypass with an explicit policy for the backend-only group. API ownership,
-- consent, permissions and knowledge-catalogue restrictions remain mandatory.
-- No PUBLIC/browser policy, no ALTER TABLE DISABLE RLS, no grants on clinical EMR.
DO $ai$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'ai_access_policies','ai_action_proposals','ai_action_receipts',
    'ai_allowance_accounts','ai_allowance_ledger','ai_allowance_policies',
    'ai_allowance_reservations','ai_allowance_windows','ai_document_pages',
    'ai_document_sources','ai_enrollments','ai_knowledge_documents',
    'ai_knowledge_passages','ai_messages','ai_personal_memories','ai_runs',
    'ai_runtime_policy','ai_sessions'
  ] LOOP
    IF NOT EXISTS (SELECT FROM pg_class WHERE oid=to_regclass(format('public.%I',table_name))
      AND relkind='r' AND relrowsecurity AND NOT relforcerowsecurity) THEN
      RAISE EXCEPTION 'Unexpected AI table security definition: %', table_name;
    END IF;
    EXECUTE format('GRANT SELECT, INSERT ON TABLE public.%I TO sabi_application_server',table_name);
    IF table_name NOT IN ('ai_action_receipts','ai_allowance_ledger') THEN
      EXECUTE format('GRANT UPDATE, DELETE ON TABLE public.%I TO sabi_application_server',table_name);
    END IF;
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public'
      AND tablename=table_name AND policyname='sabi_backend_only') THEN
      EXECUTE format('CREATE POLICY sabi_backend_only ON public.%I TO sabi_application_server USING (true) WITH CHECK (true)',table_name);
    END IF;
  END LOOP;
END $ai$;

-- Worker-only job metadata; the assessment content still requires withTenant().
GRANT SELECT, UPDATE ON jev_assessment_jobs TO
  "sabi-worker-production@project-2dfff4eb-ff04-40b1-aff.iam";
DO $job$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='public'
    AND tablename='jev_assessment_jobs' AND policyname='sabi_job_worker') THEN
    CREATE POLICY sabi_job_worker ON jev_assessment_jobs
      TO "sabi-worker-production@project-2dfff4eb-ff04-40b1-aff.iam"
      USING (true) WITH CHECK (true);
  END IF;
END $job$;
COMMIT;
