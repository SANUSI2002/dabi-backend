-- Phone and computer notifications (Web Push). One row per browser or installed app that allowed
-- notifications; the endpoint belongs to the browser vendor's push service and is unique.
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "endpoint" VARCHAR(1000) NOT NULL,
    "p256dh" VARCHAR(200) NOT NULL,
    "auth" VARCHAR(100) NOT NULL,
    "device" VARCHAR(160),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_success_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");
CREATE INDEX "push_subscriptions_user_id_revoked_at_idx" ON "push_subscriptions"("user_id", "revoked_at");

-- Which kinds of update appear as phone notifications (all of them unless the patient narrows it).
ALTER TABLE "notification_preferences" ADD COLUMN "push_categories" TEXT[] DEFAULT ARRAY['MEDICATION', 'APPOINTMENT', 'CARE']::TEXT[];

-- A dose can also be recorded from a notification's Taken button.
ALTER TABLE "medication_doses" DROP CONSTRAINT "medication_doses_confirmed_via_check";
ALTER TABLE "medication_doses" ADD CONSTRAINT "medication_doses_confirmed_via_check" CHECK ("confirmed_via" IS NULL OR "confirmed_via" IN ('APP', 'WHATSAPP', 'PUSH'));
