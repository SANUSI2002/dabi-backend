-- Platform configuration shared by every product: master-data lists (leave types, ward types, sample
-- types…), the organization's own names for its hierarchy (terminology), letter templates and the log
-- of letters generated from them. Seeded once per organization from the starter lists, then edited.
-- Editing follows the list's product: Workforce lists with hr.manage, EMR lists with catalog.manage,
-- platform-wide lists, terminology with platform.config.

CREATE TABLE "platform_master_items" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "category" VARCHAR(40) NOT NULL, "label" VARCHAR(120) NOT NULL, "code" VARCHAR(40),
  "active" BOOLEAN NOT NULL DEFAULT true, "system" BOOLEAN NOT NULL DEFAULT false, "meta" JSONB NOT NULL DEFAULT '{}', "sort" INTEGER NOT NULL DEFAULT 0,
  "removed_at" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_master_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_master_items_values_check" CHECK ("category" ~ '^[a-z][a-z0-9-]{1,39}$' AND jsonb_typeof("meta") = 'object' AND NOT ("system" AND "removed_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "platform_master_items_code_key" ON "platform_master_items"("organization_id", "category", "code") WHERE "code" IS NOT NULL AND "removed_at" IS NULL;
CREATE UNIQUE INDEX "platform_master_items_label_key" ON "platform_master_items"("organization_id", "category", lower("label")) WHERE "removed_at" IS NULL;

CREATE TABLE "platform_terms" (
  "organization_id" TEXT NOT NULL, "overrides" JSONB NOT NULL DEFAULT '{}', "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" TEXT, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_terms_pkey" PRIMARY KEY ("organization_id"), CONSTRAINT "platform_terms_overrides_check" CHECK (jsonb_typeof("overrides") = 'object')
);

CREATE TABLE "platform_letter_templates" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "key" VARCHAR(60) NOT NULL, "name" VARCHAR(160) NOT NULL, "category" VARCHAR(12) NOT NULL,
  "body" VARCHAR(20000) NOT NULL, "signatories" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "active" BOOLEAN NOT NULL DEFAULT true, "system" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1, "updated_by_user_id" TEXT, "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_letter_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_letter_templates_values_check" CHECK ("category" IN ('Onboarding', 'Discipline', 'Movement', 'Finance', 'General') AND "key" ~ '^[a-z0-9][a-z0-9-]{1,59}$')
);
CREATE UNIQUE INDEX "platform_letter_templates_key" ON "platform_letter_templates"("organization_id", "key");

-- A generated letter keeps the text as it was rendered; only "sent" can be recorded afterwards.
CREATE TABLE "platform_letters" (
  "id" TEXT NOT NULL, "organization_id" TEXT NOT NULL, "template_key" VARCHAR(60) NOT NULL, "title" VARCHAR(200) NOT NULL, "subject_employee_id" TEXT,
  "reference" VARCHAR(100), "data" JSONB NOT NULL, "rendered" VARCHAR(40000) NOT NULL, "generated_by_user_id" TEXT NOT NULL,
  "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "sent_at" TIMESTAMP(3), "sent_to" VARCHAR(160), "sent_by_user_id" TEXT,
  CONSTRAINT "platform_letters_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_letters_values_check" CHECK (jsonb_typeof("data") = 'object' AND (("sent_at" IS NULL) = ("sent_to" IS NULL)))
);
CREATE INDEX "platform_letters_reference_idx" ON "platform_letters"("organization_id", "reference");

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['platform_master_items', 'platform_terms', 'platform_letter_templates', 'platform_letters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO sabi_emr_app', t);
  END LOOP;
END $$;
GRANT UPDATE ("label", "code", "active", "meta", "sort", "removed_at", "version") ON "platform_master_items" TO sabi_emr_app;
GRANT UPDATE ("overrides", "version", "updated_by_user_id", "updated_at") ON "platform_terms" TO sabi_emr_app;
GRANT UPDATE ("name", "category", "body", "signatories", "active", "version", "updated_by_user_id", "updated_at") ON "platform_letter_templates" TO sabi_emr_app;
GRANT UPDATE ("sent_at", "sent_to", "sent_by_user_id") ON "platform_letters" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('platform.config', 'Manage platform-wide lists and the organization''s terminology')
ON CONFLICT ("code") DO NOTHING;
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HOSPITAL_ADMIN', 'platform.config'), ('ORGANISATION_OWNER', 'platform.config')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
