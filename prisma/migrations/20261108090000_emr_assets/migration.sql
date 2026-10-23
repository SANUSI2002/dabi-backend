-- Equipment & maintenance: the hospital's asset register (with its preventive-maintenance interval and
-- last service date), and maintenance jobs — corrective (a reported fault) or preventive (a scheduled
-- service). A high-priority fault puts an in-service asset under repair; resolving the last open job
-- puts it back in service and stamps the service date. Nothing is deleted.

CREATE TABLE "emr_assets" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "tag" VARCHAR(30) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "category" VARCHAR(12) NOT NULL,
  "location" VARCHAR(120) NOT NULL,
  "status" VARCHAR(14) NOT NULL DEFAULT 'IN_SERVICE',
  "serial_number" VARCHAR(60),
  "cost_minor" BIGINT,
  "commissioned_on" DATE NOT NULL,
  "service_interval_days" INTEGER NOT NULL,
  "last_serviced_on" DATE NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_assets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_assets_org_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_assets_values_check" CHECK (
    "category" IN ('Cold chain', 'Maternity', 'Diagnostics', 'Power', 'IT', 'General') AND
    "status" IN ('IN_SERVICE', 'UNDER_REPAIR', 'OUT_OF_SERVICE', 'RETIRED') AND
    "service_interval_days" BETWEEN 1 AND 3650 AND ("cost_minor" IS NULL OR "cost_minor" >= 0) AND "last_serviced_on" >= "commissioned_on"
  )
);
CREATE UNIQUE INDEX "emr_assets_organization_id_tag_key" ON "emr_assets"("organization_id", "tag");

CREATE TABLE "emr_maintenance_jobs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "asset_id" TEXT NOT NULL,
  "type" VARCHAR(10) NOT NULL,
  "summary" VARCHAR(1000) NOT NULL,
  "priority" VARCHAR(6) NOT NULL,
  "status" VARCHAR(11) NOT NULL DEFAULT 'OPEN',
  "reported_by_user_id" TEXT NOT NULL,
  "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "resolution" VARCHAR(1000),
  "resolved_by_user_id" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "emr_maintenance_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_maintenance_jobs_asset_fkey" FOREIGN KEY ("organization_id", "asset_id") REFERENCES "emr_assets"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_maintenance_jobs_values_check" CHECK (
    "type" IN ('CORRECTIVE', 'PREVENTIVE') AND "priority" IN ('LOW', 'MEDIUM', 'HIGH') AND "status" IN ('OPEN', 'IN_PROGRESS', 'RESOLVED') AND
    ("status" <> 'RESOLVED' OR ("closed_at" IS NOT NULL AND "resolution" IS NOT NULL AND "resolved_by_user_id" IS NOT NULL))
  )
);
CREATE INDEX "emr_maintenance_jobs_asset_idx" ON "emr_maintenance_jobs"("organization_id", "asset_id", "status");
-- One open preventive job per asset at a time.
CREATE UNIQUE INDEX "emr_maintenance_jobs_one_open_pm_key" ON "emr_maintenance_jobs"("organization_id", "asset_id") WHERE "type" = 'PREVENTIVE' AND "status" <> 'RESOLVED';

ALTER TABLE "emr_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_assets" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_assets_tenant" ON "emr_assets" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
ALTER TABLE "emr_maintenance_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_maintenance_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_maintenance_jobs_tenant" ON "emr_maintenance_jobs" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_assets", "emr_maintenance_jobs" TO sabi_emr_app;
GRANT UPDATE ("status", "location", "last_serviced_on", "version") ON "emr_assets" TO sabi_emr_app;
GRANT UPDATE ("status", "started_at", "closed_at", "resolution", "resolved_by_user_id", "version") ON "emr_maintenance_jobs" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('equipment.read', 'View the equipment register and maintenance jobs'),
  ('equipment.report', 'Report an equipment fault'),
  ('equipment.manage', 'Register equipment, change its status, and run maintenance jobs and preventive servicing')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('INVENTORY_OFFICER', 'equipment.read'), ('INVENTORY_OFFICER', 'equipment.report'), ('INVENTORY_OFFICER', 'equipment.manage'),
  ('HOSPITAL_ADMIN', 'equipment.read'), ('HOSPITAL_ADMIN', 'equipment.report'), ('HOSPITAL_ADMIN', 'equipment.manage'),
  ('DOCTOR', 'equipment.read'), ('DOCTOR', 'equipment.report'),
  ('NURSE', 'equipment.read'), ('NURSE', 'equipment.report'),
  ('LAB_SCIENTIST', 'equipment.read'), ('LAB_SCIENTIST', 'equipment.report'),
  ('PHARMACIST', 'equipment.read'), ('PHARMACIST', 'equipment.report'),
  ('RADIOGRAPHER', 'equipment.read'), ('RADIOGRAPHER', 'equipment.report')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
