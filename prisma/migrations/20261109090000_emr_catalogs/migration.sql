-- Hospital catalogs managed from Settings: the diagnosis list clinicians pick from (ICD-11 codes, with
-- chronic/NCD and notifiable flags) and patient categories (with whether they are fee-exempt). Each
-- organization gets a starter set on first use and can add, edit or deactivate entries; nothing is
-- deleted, so past records keep their codes.

CREATE TABLE "emr_diagnosis_catalog" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "code" VARCHAR(16) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "chapter" VARCHAR(80) NOT NULL,
  "ncd" BOOLEAN NOT NULL DEFAULT false,
  "notifiable" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_diagnosis_catalog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_diagnosis_catalog_code_check" CHECK ("code" ~ '^[0-9A-Z][0-9A-Z.&/]{1,15}$')
);
CREATE UNIQUE INDEX "emr_diagnosis_catalog_organization_id_code_key" ON "emr_diagnosis_catalog"("organization_id", "code");

CREATE TABLE "emr_patient_categories" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "code" VARCHAR(24) NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "exempt" BOOLEAN NOT NULL DEFAULT false,
  "reason" VARCHAR(200),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_patient_categories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_patient_categories_code_check" CHECK ("code" ~ '^[A-Z0-9_-]{1,24}$')
);
CREATE UNIQUE INDEX "emr_patient_categories_organization_id_code_key" ON "emr_patient_categories"("organization_id", "code");

ALTER TABLE "emr_diagnosis_catalog" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_diagnosis_catalog" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_diagnosis_catalog_tenant" ON "emr_diagnosis_catalog" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
ALTER TABLE "emr_patient_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "emr_patient_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "emr_patient_categories_tenant" ON "emr_patient_categories" USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "emr_diagnosis_catalog", "emr_patient_categories" TO sabi_emr_app;
GRANT UPDATE ("name", "chapter", "ncd", "notifiable", "active", "version") ON "emr_diagnosis_catalog" TO sabi_emr_app;
GRANT UPDATE ("name", "exempt", "reason", "active", "version") ON "emr_patient_categories" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('catalog.manage', 'Manage the hospital catalogs in Settings (diagnoses, patient categories)')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HOSPITAL_ADMIN', 'catalog.manage'), ('ORGANISATION_OWNER', 'catalog.manage')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
