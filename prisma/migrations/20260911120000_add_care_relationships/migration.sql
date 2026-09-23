CREATE TYPE "CareRelationshipStatus" AS ENUM ('PENDING', 'ACTIVE', 'DECLINED', 'REVOKED', 'EXPIRED');

CREATE TABLE "care_relationships" (
  "id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "caregiver_id" TEXT,
  "caregiver_email" TEXT NOT NULL,
  "relationship_type" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "status" "CareRelationshipStatus" NOT NULL DEFAULT 'PENDING',
  "invitation_token_hash" TEXT,
  "expires_at" TIMESTAMP(3),
  "responded_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "care_relationships_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "care_relationships_invitation_token_hash_key" ON "care_relationships"("invitation_token_hash");
CREATE INDEX "care_relationships_patient_id_status_idx" ON "care_relationships"("patient_id", "status");
CREATE INDEX "care_relationships_caregiver_id_status_idx" ON "care_relationships"("caregiver_id", "status");
CREATE INDEX "care_relationships_caregiver_email_status_idx" ON "care_relationships"("caregiver_email", "status");
ALTER TABLE "care_relationships" ADD CONSTRAINT "care_relationships_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "care_relationships" ADD CONSTRAINT "care_relationships_caregiver_id_fkey" FOREIGN KEY ("caregiver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
