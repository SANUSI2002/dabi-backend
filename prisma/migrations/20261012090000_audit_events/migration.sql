-- Portal audit trail: sign-ins, access to patient records, permission changes and other account
-- activity, shown to patients and professionals in their Activity log.
-- User ids are plain columns (no foreign keys) so the trail is kept when accounts change.
-- Append-only: a trigger rejects UPDATE and DELETE.

CREATE TABLE "audit_events" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "subject_user_id" TEXT,
    "related_user_id" TEXT,
    "category" VARCHAR(32) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "summary" VARCHAR(300) NOT NULL,
    "resource_type" VARCHAR(64),
    "resource_id" VARCHAR(64),
    "ip_address" VARCHAR(64),
    "device" VARCHAR(160),
    "city" VARCHAR(120),
    "region" VARCHAR(16),
    "country" VARCHAR(2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "audit_events_category_check" CHECK ("category" IN ('SIGN_IN', 'RECORD_ACCESS', 'RECORD_CHANGE', 'PERMISSION', 'ACCOUNT', 'ACTIVITY'))
);

CREATE INDEX "audit_events_actor_user_id_created_at_idx" ON "audit_events"("actor_user_id", "created_at" DESC);
CREATE INDEX "audit_events_subject_user_id_created_at_idx" ON "audit_events"("subject_user_id", "created_at" DESC);
CREATE INDEX "audit_events_related_user_id_created_at_idx" ON "audit_events"("related_user_id", "created_at" DESC);

CREATE OR REPLACE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END $$;
CREATE TRIGGER "audit_events_no_change" BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
