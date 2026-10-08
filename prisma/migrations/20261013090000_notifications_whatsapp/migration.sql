-- Central notifications, WhatsApp as an opt-in channel, and medication schedules with per-dose records.
-- See docs/NOTIFICATIONS_WHATSAPP.md.

-- In-app notifications gain a category, the event that caused them and an idempotency key.
ALTER TABLE "notifications"
    ADD COLUMN "category" VARCHAR(32) NOT NULL DEFAULT 'GENERAL',
    ADD COLUMN "event_type" VARCHAR(64),
    ADD COLUMN "event_key" VARCHAR(160),
    ADD COLUMN "link" VARCHAR(300);
CREATE UNIQUE INDEX "notifications_user_id_event_key_key" ON "notifications"("user_id", "event_key");

CREATE TABLE "notification_deliveries" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "connection_id" TEXT,
    "reminder_job_id" TEXT,
    "provider_message_id" VARCHAR(128),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" VARCHAR(300),
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "notification_deliveries_channel_check" CHECK ("channel" IN ('WHATSAPP', 'PUSH')),
    CONSTRAINT "notification_deliveries_status_check" CHECK ("status" IN ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED', 'CANCELLED'))
);
CREATE UNIQUE INDEX "notification_deliveries_provider_message_id_key" ON "notification_deliveries"("provider_message_id");
CREATE UNIQUE INDEX "notification_deliveries_notification_id_channel_key" ON "notification_deliveries"("notification_id", "channel");
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");
CREATE INDEX "notification_deliveries_user_id_created_at_idx" ON "notification_deliveries"("user_id", "created_at" DESC);

CREATE TABLE "notification_preferences" (
    "user_id" TEXT NOT NULL,
    "whatsapp_enabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsapp_categories" TEXT[] DEFAULT ARRAY['MEDICATION']::TEXT[],
    "show_medication_details" BOOLEAN NOT NULL DEFAULT false,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Africa/Lagos',
    "consent_version" VARCHAR(64),
    "consented_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id"),
    CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "whatsapp_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "code_hash" VARCHAR(128),
    "code_expires_at" TIMESTAMP(3),
    "code_attempts" INTEGER NOT NULL DEFAULT 0,
    "codes_sent" INTEGER NOT NULL DEFAULT 0,
    "code_sent_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" VARCHAR(32),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_connections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "whatsapp_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "whatsapp_connections_status_check" CHECK ("status" IN ('PENDING', 'ACTIVE', 'REVOKED')),
    CONSTRAINT "whatsapp_connections_phone_check" CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE INDEX "whatsapp_connections_user_id_status_idx" ON "whatsapp_connections"("user_id", "status");
CREATE INDEX "whatsapp_connections_phone_status_idx" ON "whatsapp_connections"("phone", "status");
-- One linked number per patient, one patient per number, one code outstanding per patient.
CREATE UNIQUE INDEX "whatsapp_connections_one_active_per_user" ON "whatsapp_connections"("user_id") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "whatsapp_connections_one_active_per_phone" ON "whatsapp_connections"("phone") WHERE "status" = 'ACTIVE';
CREATE UNIQUE INDEX "whatsapp_connections_one_pending_per_user" ON "whatsapp_connections"("user_id") WHERE "status" = 'PENDING';

CREATE TABLE "medication_schedules" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "prescription_item_id" TEXT,
    "medication_id" TEXT,
    "name" VARCHAR(120) NOT NULL,
    "dosage" VARCHAR(64),
    "instructions" VARCHAR(500),
    "as_needed" BOOLEAN NOT NULL DEFAULT false,
    "times" TEXT[],
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Africa/Lagos',
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "reminders_enabled" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "materialized_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medication_schedules_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "medication_schedules_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "medication_schedules_source_check" CHECK ("source" IN ('PRESCRIPTION', 'PATIENT')),
    CONSTRAINT "medication_schedules_status_check" CHECK ("status" IN ('ACTIVE', 'PAUSED', 'STOPPED', 'COMPLETED')),
    CONSTRAINT "medication_schedules_source_link_check" CHECK ("source" <> 'PRESCRIPTION' OR "prescription_item_id" IS NOT NULL),
    CONSTRAINT "medication_schedules_dates_check" CHECK ("end_date" IS NULL OR "end_date" >= "start_date")
);
CREATE INDEX "medication_schedules_user_id_status_idx" ON "medication_schedules"("user_id", "status");
CREATE INDEX "medication_schedules_status_materialized_until_idx" ON "medication_schedules"("status", "materialized_until");
-- A prescribed medicine has at most one live schedule.
CREATE UNIQUE INDEX "medication_schedules_one_live_per_prescription_item" ON "medication_schedules"("prescription_item_id") WHERE "status" IN ('ACTIVE', 'PAUSED') AND "prescription_item_id" IS NOT NULL;

CREATE TABLE "medication_doses" (
    "id" TEXT NOT NULL,
    "schedule_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "schedule_version" INTEGER NOT NULL,
    "scheduled_for" TIMESTAMP(3) NOT NULL,
    "local_time" VARCHAR(5) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'NOT_CONFIRMED',
    "confirmed_at" TIMESTAMP(3),
    "confirmed_via" VARCHAR(16),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "medication_doses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "medication_doses_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "medication_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "medication_doses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "medication_doses_status_check" CHECK ("status" IN ('NOT_CONFIRMED', 'TAKEN', 'SKIPPED', 'CANCELLED')),
    CONSTRAINT "medication_doses_confirmed_via_check" CHECK ("confirmed_via" IS NULL OR "confirmed_via" IN ('APP', 'WHATSAPP'))
);
CREATE UNIQUE INDEX "medication_doses_schedule_id_scheduled_for_key" ON "medication_doses"("schedule_id", "scheduled_for");
CREATE INDEX "medication_doses_user_id_scheduled_for_idx" ON "medication_doses"("user_id", "scheduled_for");

CREATE TABLE "reminder_jobs" (
    "id" TEXT NOT NULL,
    "dose_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "due_at" TIMESTAMP(3) NOT NULL,
    "original_due_at" TIMESTAMP(3) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'SCHEDULED',
    "snooze_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" VARCHAR(300),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reminder_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reminder_jobs_dose_id_fkey" FOREIGN KEY ("dose_id") REFERENCES "medication_doses"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "reminder_jobs_status_check" CHECK ("status" IN ('SCHEDULED', 'SNOOZED', 'SENT', 'EXPIRED', 'CANCELLED', 'FAILED'))
);
CREATE UNIQUE INDEX "reminder_jobs_dose_id_key" ON "reminder_jobs"("dose_id");
CREATE INDEX "reminder_jobs_status_due_at_idx" ON "reminder_jobs"("status", "due_at");

CREATE TABLE "whatsapp_webhook_events" (
    "id" VARCHAR(200) NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "whatsapp_webhook_events_pkey" PRIMARY KEY ("id")
);
