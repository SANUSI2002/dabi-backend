CREATE TABLE "platform_packages" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "recommended" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "branch_limit" INTEGER NOT NULL DEFAULT 1,
  "storage_limit_gb" INTEGER NOT NULL DEFAULT 10,
  "support_level" TEXT NOT NULL DEFAULT 'STANDARD',
  "published_version" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_packages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_packages_limits_check" CHECK ("branch_limit" > 0 AND "storage_limit_gb" > 0),
  CONSTRAINT "platform_packages_support_check" CHECK ("support_level" IN ('STANDARD', 'PRIORITY', 'DEDICATED'))
);
CREATE UNIQUE INDEX "platform_packages_code_key" ON "platform_packages"("code");

CREATE TABLE "platform_package_versions" (
  "id" TEXT NOT NULL,
  "package_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "monthly_price_minor" INTEGER NOT NULL,
  "annual_price_minor" INTEGER NOT NULL,
  "module_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  CONSTRAINT "platform_package_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_package_versions_price_check" CHECK ("monthly_price_minor" >= 0 AND "annual_price_minor" >= 0),
  CONSTRAINT "platform_package_versions_status_check" CHECK ("status" IN ('DRAFT', 'PUBLISHED', 'RETIRED'))
);
CREATE UNIQUE INDEX "platform_package_versions_package_id_version_key" ON "platform_package_versions"("package_id", "version");
CREATE INDEX "platform_package_versions_package_id_status_idx" ON "platform_package_versions"("package_id", "status");
ALTER TABLE "platform_package_versions" ADD CONSTRAINT "platform_package_versions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "platform_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "platform_applications" (
  "id" TEXT NOT NULL,
  "client_draft_id" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "owner_email" TEXT NOT NULL,
  "organization_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'AWAITING_EMAIL',
  "details" JSONB NOT NULL,
  "package_id" TEXT NOT NULL,
  "package_version_id" TEXT NOT NULL,
  "billing_cycle" TEXT NOT NULL,
  "verification_token_hash" TEXT,
  "verification_expires_at" TIMESTAMP(3),
  "email_verified_at" TIMESTAMP(3),
  "submitted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "platform_applications_status_check" CHECK ("status" IN ('AWAITING_EMAIL', 'SUBMITTED', 'UNDER_REVIEW', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED')),
  CONSTRAINT "platform_applications_cycle_check" CHECK ("billing_cycle" IN ('Monthly', 'Annual'))
);
CREATE UNIQUE INDEX "platform_applications_client_draft_id_key" ON "platform_applications"("client_draft_id");
CREATE UNIQUE INDEX "platform_applications_reference_key" ON "platform_applications"("reference");
CREATE UNIQUE INDEX "platform_applications_verification_token_hash_key" ON "platform_applications"("verification_token_hash");
CREATE INDEX "platform_applications_status_created_at_idx" ON "platform_applications"("status", "created_at");
CREATE INDEX "platform_applications_owner_email_created_at_idx" ON "platform_applications"("owner_email", "created_at");
ALTER TABLE "platform_applications" ADD CONSTRAINT "platform_applications_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "platform_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "platform_applications" ADD CONSTRAINT "platform_applications_package_version_id_fkey" FOREIGN KEY ("package_version_id") REFERENCES "platform_package_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
