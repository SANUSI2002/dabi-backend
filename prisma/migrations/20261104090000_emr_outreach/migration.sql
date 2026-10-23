-- Community outreach. A Community Health Worker role (members who carry out outreach), and the log of
-- outreach activities: household visits, health talks, campaigns, defaulter tracing and screening, each
-- with the households reached and community referrals made. Logged by the CHW or a supervising nurse;
-- never edited or deleted (a mistaken entry is marked entered in error).

INSERT INTO "access_roles" ("code", "scope", "description") VALUES
  ('COMMUNITY_HEALTH_WORKER', 'ORGANIZATION', 'Community health worker (outreach)')
ON CONFLICT ("code") DO NOTHING;

CREATE TABLE "emr_outreach_activities" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "chw_user_id" TEXT NOT NULL,
  "activity_type" VARCHAR(30) NOT NULL,
  "ward" VARCHAR(120) NOT NULL,
  "households" INTEGER NOT NULL,
  "referrals" INTEGER NOT NULL,
  "activity_date" DATE NOT NULL,
  "notes" VARCHAR(2000),
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "recorded_by_user_id" TEXT NOT NULL,
  "entered_in_error_reason" VARCHAR(500),
  "entered_in_error_by_user_id" TEXT,
  "entered_in_error_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_outreach_activities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_outreach_activities_values_check" CHECK (
    "activity_type" IN ('Household visit', 'Health talk', 'Immunization campaign', 'Defaulter tracing', 'Community screening') AND
    "households" BETWEEN 0 AND 100000 AND "referrals" BETWEEN 0 AND 100000 AND "status" IN ('ACTIVE', 'ENTERED_IN_ERROR') AND
    ("status" <> 'ENTERED_IN_ERROR' OR ("entered_in_error_reason" IS NOT NULL AND "entered_in_error_by_user_id" IS NOT NULL AND "entered_in_error_at" IS NOT NULL))
  )
);
CREATE INDEX "emr_outreach_activities_organization_id_activity_date_idx" ON "emr_outreach_activities"("organization_id", "activity_date");

ALTER TABLE "emr_outreach_activities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_outreach_activities" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_outreach_activities_tenant" ON "emr_outreach_activities" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_outreach_activities" TO sabi_emr_app;
GRANT UPDATE ("status", "entered_in_error_reason", "entered_in_error_by_user_id", "entered_in_error_at") ON "emr_outreach_activities" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('outreach.read', 'View community outreach activities and the CHW roster'),
  ('outreach.record', 'Log community outreach activities'),
  ('outreach.chw', 'Carries out community outreach (listed on the CHW roster)')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('COMMUNITY_HEALTH_WORKER', 'outreach.read'), ('COMMUNITY_HEALTH_WORKER', 'outreach.record'), ('COMMUNITY_HEALTH_WORKER', 'outreach.chw'),
  ('NURSE', 'outreach.read'), ('NURSE', 'outreach.record'),
  ('DOCTOR', 'outreach.read'),
  ('HOSPITAL_ADMIN', 'outreach.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
