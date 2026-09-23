-- AlterEnum
ALTER TYPE "UserRoleType" ADD VALUE 'CAREGIVER';

-- CreateTable
CREATE TABLE "caregiver_profiles" (
    "user_id" TEXT NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "caregiver_type" TEXT NOT NULL,
    "connection_mode" TEXT NOT NULL,
    "connection_reference" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "privacy_accepted_at" TIMESTAMP(3) NOT NULL,
    "consent_version" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "caregiver_profiles_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "caregiver_profiles" ADD CONSTRAINT "caregiver_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
