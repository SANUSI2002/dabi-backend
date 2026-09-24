ALTER TABLE "platform_applications"
ADD COLUMN "evidence_access_token_hash" TEXT,
ADD COLUMN "evidence_access_expires_at" TIMESTAMP(3),
ADD COLUMN "evidence_access_sent_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "platform_applications_evidence_access_token_hash_key"
ON "platform_applications"("evidence_access_token_hash");

DROP INDEX "platform_application_evidence_application_id_requirement_key_key";
CREATE INDEX "platform_application_evidence_application_id_requirement_key_created_at_idx"
ON "platform_application_evidence"("application_id", "requirement_key", "created_at");

CREATE TABLE "platform_application_evidence_events" (
  "id" TEXT NOT NULL,
  "evidence_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "actor_kind" TEXT NOT NULL,
  "actor_id" TEXT,
  "details" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_application_evidence_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platform_application_evidence_events_evidence_id_created_at_idx"
ON "platform_application_evidence_events"("evidence_id", "created_at");
ALTER TABLE "platform_application_evidence_events"
ADD CONSTRAINT "platform_application_evidence_events_evidence_id_fkey"
FOREIGN KEY ("evidence_id") REFERENCES "platform_application_evidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
