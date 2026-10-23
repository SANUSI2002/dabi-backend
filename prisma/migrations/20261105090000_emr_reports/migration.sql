-- Reporting. Period counts and report sources are read-only views over the record (no copies). The
-- Monthly Summary Form (MSF) is the one thing stored: one return per organization and month, a draft of
-- figures the compiler can adjust, then locked as COMPILED. Locking does not send it anywhere — no
-- connection to the LGA, DHIS2 or any national platform exists.

CREATE TABLE "emr_msf_returns" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "period" VARCHAR(7) NOT NULL,
  "values" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" VARCHAR(8) NOT NULL DEFAULT 'DRAFT',
  "updated_by_user_id" TEXT NOT NULL,
  "compiled_by_user_id" TEXT,
  "compiled_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_msf_returns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_msf_returns_values_check" CHECK (
    "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$' AND "status" IN ('DRAFT', 'COMPILED') AND jsonb_typeof("values") = 'object' AND
    ("status" <> 'COMPILED' OR ("compiled_by_user_id" IS NOT NULL AND "compiled_at" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "emr_msf_returns_organization_id_period_key" ON "emr_msf_returns"("organization_id", "period");

ALTER TABLE "emr_msf_returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_msf_returns" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_msf_returns_tenant" ON "emr_msf_returns" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_msf_returns" TO sabi_emr_app;
GRANT UPDATE ("values", "status", "updated_by_user_id", "compiled_by_user_id", "compiled_at", "version", "updated_at") ON "emr_msf_returns" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('report.view', 'View reports and period statistics computed from the record'),
  ('report.compile', 'Compile and lock the Monthly Summary Form')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HOSPITAL_ADMIN', 'report.view'), ('HOSPITAL_ADMIN', 'report.compile'),
  ('ORGANISATION_OWNER', 'report.view'), ('ORGANISATION_OWNER', 'report.compile'),
  ('DOCTOR', 'report.view'),
  ('NURSE', 'report.view')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
