-- AlterTable
ALTER TABLE "care_relationships" ADD COLUMN     "invitation_kind" TEXT NOT NULL DEFAULT 'DIRECT',
ADD COLUMN     "join_requested_at" TIMESTAMP(3),
ADD COLUMN     "permission_level" TEXT,
ADD COLUMN     "relationship_label" TEXT,
ADD COLUMN     "requested_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "dependent_profiles" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "nickname" TEXT,
    "date_of_birth" DATE,
    "gender" TEXT,
    "blood_group" TEXT,
    "genotype" TEXT,
    "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "conditions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "care_type" TEXT,
    "immunization_status" TEXT,
    "milestones" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "weight_kg" DOUBLE PRECISION,
    "height_cm" DOUBLE PRECISION,
    "primary_physician" TEXT,
    "insurance_provider" TEXT,
    "policy_number" TEXT,
    "co_manager_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dependent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dependent_profiles_patient_id_created_at_idx" ON "dependent_profiles"("patient_id", "created_at");

-- AddForeignKey
ALTER TABLE "dependent_profiles" ADD CONSTRAINT "dependent_profiles_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
