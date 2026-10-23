-- Family planning (Maternal & Child Health, part 5). A client is registered once while on a method
-- (one active registration per person); visits record revisits, resupply, switching method and
-- removal (which discontinues). Visits are append-only; a registration only changes method, next
-- visit date, or closes with a reason.

CREATE TABLE "emr_fp_clients" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "method" VARCHAR(40) NOT NULL,
  "first_time" BOOLEAN NOT NULL DEFAULT false,
  "start_date" DATE NOT NULL,
  "next_visit_date" DATE,
  "counselled" BOOLEAN NOT NULL DEFAULT true,
  "notes" VARCHAR(1000),
  "status" VARCHAR(14) NOT NULL DEFAULT 'ACTIVE',
  "discontinue_reason" VARCHAR(60),
  "discontinued_at" TIMESTAMP(3),
  "discontinued_by_user_id" TEXT,
  "registered_by_user_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_fp_clients_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_fp_clients_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_fp_clients_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_fp_clients_status_check" CHECK ("status" IN ('ACTIVE', 'DISCONTINUED')),
  CONSTRAINT "emr_fp_clients_closed_check" CHECK (("status" = 'DISCONTINUED') = ("discontinue_reason" IS NOT NULL AND "discontinued_at" IS NOT NULL AND "discontinued_by_user_id" IS NOT NULL))
);
CREATE UNIQUE INDEX "emr_fp_clients_one_active_key" ON "emr_fp_clients"("organization_id", "patient_id") WHERE "status" = 'ACTIVE';
CREATE INDEX "emr_fp_clients_organization_id_created_at_idx" ON "emr_fp_clients"("organization_id", "created_at");

CREATE TABLE "emr_fp_visits" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "client_id" TEXT NOT NULL,
  "visit_date" DATE NOT NULL,
  "visit_type" VARCHAR(14) NOT NULL,
  "method" VARCHAR(40) NOT NULL,
  "next_visit_date" DATE,
  "notes" VARCHAR(1000),
  "recorded_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_fp_visits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_fp_visits_client_fkey" FOREIGN KEY ("organization_id", "client_id") REFERENCES "emr_fp_clients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_fp_visits_type_check" CHECK ("visit_type" IN ('NEW_VISIT', 'REVISIT', 'RESUPPLY', 'SWITCH_METHOD', 'REMOVAL'))
);
CREATE INDEX "emr_fp_visits_client_idx" ON "emr_fp_visits"("organization_id", "client_id", "visit_date");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_fp_clients', 'emr_fp_visits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON "emr_fp_clients" TO sabi_emr_app;
GRANT UPDATE ("method", "next_visit_date", "status", "discontinue_reason", "discontinued_at", "discontinued_by_user_id", "version", "updated_at") ON "emr_fp_clients" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_fp_visits" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('fp.read', 'View family planning clients and visits'),
  ('fp.manage', 'Register family planning clients and record visits')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'fp.read'), ('DOCTOR', 'fp.manage'),
  ('NURSE', 'fp.read'), ('NURSE', 'fp.manage'),
  ('HOSPITAL_ADMIN', 'fp.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
