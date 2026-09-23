-- CreateEnum
CREATE TYPE "OrganisationType" AS ENUM ('HOSPITAL', 'CLINIC', 'LABORATORY', 'DIAGNOSTIC_CENTRE', 'OTHER');

-- CreateEnum
CREATE TYPE "OrganisationStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- AlterEnum
ALTER TYPE "UserRoleType" ADD VALUE 'ORGANISATION_OWNER';

-- CreateTable
CREATE TABLE "organisations" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "type" "OrganisationType" NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "contact_phone" TEXT NOT NULL,
    "status" "OrganisationStatus" NOT NULL DEFAULT 'PENDING',
    "decision_note" TEXT,
    "decided_by_user_id" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_submissions" (
    "id" TEXT NOT NULL,
    "organisation_id" TEXT,
    "pharmacy_id" TEXT,
    "details" JSONB NOT NULL,
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "privacy_accepted_at" TIMESTAMP(3) NOT NULL,
    "health_data_accepted_at" TIMESTAMP(3),
    "consent_version" TEXT NOT NULL DEFAULT '1.0',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisation_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_documents" (
    "id" TEXT NOT NULL,
    "submission_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "content" BYTEA NOT NULL,

    CONSTRAINT "organisation_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organisations_owner_id_key" ON "organisations"("owner_id");

-- CreateIndex
CREATE INDEX "organisations_status_type_idx" ON "organisations"("status", "type");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_submissions_organisation_id_key" ON "organisation_submissions"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_submissions_pharmacy_id_key" ON "organisation_submissions"("pharmacy_id");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_documents_submission_id_key_key" ON "organisation_documents"("submission_id", "key");

-- AddForeignKey
ALTER TABLE "organisations" ADD CONSTRAINT "organisations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_submissions" ADD CONSTRAINT "organisation_submissions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_submissions" ADD CONSTRAINT "organisation_submissions_pharmacy_id_fkey" FOREIGN KEY ("pharmacy_id") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_documents" ADD CONSTRAINT "organisation_documents_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "organisation_submissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Evidence belongs to exactly one verification system, never both.
ALTER TABLE "organisation_submissions" ADD CONSTRAINT "organisation_submissions_single_facility"
CHECK (("organisation_id" IS NOT NULL) <> ("pharmacy_id" IS NOT NULL));
