-- Additive only. A card is an identifier, never a bearer credential. Existing patients do not opt in.
ALTER TABLE "user_profiles"
  ADD COLUMN "emergency_code" VARCHAR(40),
  ADD COLUMN "emergency_code_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "emergency_sharing_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "emergency_circle_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "emergency_hospitals_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "emergency_display_name" VARCHAR(120),
  ADD COLUMN "emergency_consent_version" VARCHAR(64),
  ADD COLUMN "emergency_consented_at" TIMESTAMP(3),
  ADD CONSTRAINT "emergency_card_consent_check" CHECK (NOT "emergency_sharing_enabled" OR
    ("emergency_consented_at" IS NOT NULL AND "emergency_consent_version" IS NOT NULL
     AND ("emergency_circle_enabled" OR "emergency_hospitals_enabled")));
CREATE UNIQUE INDEX "user_profiles_emergency_code_key" ON "user_profiles"("emergency_code");
ALTER TABLE "notification_preferences" ADD COLUMN "emergency_card_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "audit_events" ADD COLUMN "context" JSONB;
-- Preserve invitation expiry/history and all existing permissions. Active access expiry is separate.
ALTER TABLE "care_relationships" ADD COLUMN "access_expires_at" TIMESTAMP(3);
-- Old UI automatically appended EMERGENCY_SUMMARY. Preserve it, but require an explicit new
-- owner confirmation before it grants Emergency Card access. Never backfill this consent stamp.
ALTER TABLE "care_relationships" ADD COLUMN "emergency_access_granted_at" TIMESTAMP(3);
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('emergency.summary.read', 'Read a consenting Sabi patient emergency summary with an access reason') ON CONFLICT DO NOTHING;
-- Not granted to admins, reception, finance, laboratory, pharmacy, or ordinary registered users.
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'emergency.summary.read'), ('NURSE', 'emergency.summary.read') ON CONFLICT DO NOTHING;
