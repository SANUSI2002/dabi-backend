-- Module switches: within the products its approved package includes, an organization can switch a module
-- (or a submodule) off and on again. One row per organization holding the keys that are switched off;
-- no row = everything the package includes is on. The API refuses a switched-off module's requests.
-- Changed by platform.config (hospital admin, owner), with optimistic locking.

CREATE TABLE "platform_module_settings" (
  "organization_id" TEXT NOT NULL,
  "disabled" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_user_id" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_module_settings_pkey" PRIMARY KEY ("organization_id"),
  CONSTRAINT "platform_module_settings_disabled_check" CHECK (cardinality("disabled") <= 100)
);

ALTER TABLE "platform_module_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_module_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "platform_module_settings_tenant" ON "platform_module_settings"
  USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization());
GRANT SELECT, INSERT ON "platform_module_settings" TO sabi_emr_app;
GRANT UPDATE ("disabled", "version", "updated_by_user_id", "updated_at") ON "platform_module_settings" TO sabi_emr_app;
