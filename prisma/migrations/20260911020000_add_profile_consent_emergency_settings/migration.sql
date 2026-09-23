ALTER TABLE "user_profiles"
  ADD COLUMN "data_sharing_consent_at" TIMESTAMP(3),
  ADD COLUMN "electronic_health_records_at" TIMESTAMP(3),
  ADD COLUMN "emergency_contact_name" TEXT,
  ADD COLUMN "emergency_contact_phone" TEXT,
  ADD COLUMN "emergency_contact_relation" TEXT;
