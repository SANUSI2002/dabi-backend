CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'CANCELLED', 'EXPIRED');
CREATE TABLE "payment_attempts" (
 "id" TEXT NOT NULL,"order_id" TEXT NOT NULL,"provider" TEXT NOT NULL,"idempotency_key" TEXT NOT NULL,"provider_reference" TEXT NOT NULL,"status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',"amount_minor" INTEGER NOT NULL,"currency" TEXT NOT NULL,"authorization_url" TEXT,"access_code" TEXT,"expires_at" TIMESTAMP(3) NOT NULL,"completed_at" TIMESTAMP(3),"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "payment_attempts_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "payment_attempts_provider_reference_key" ON "payment_attempts"("provider_reference");
CREATE UNIQUE INDEX "payment_attempts_order_id_idempotency_key_key" ON "payment_attempts"("order_id","idempotency_key");
CREATE INDEX "payment_attempts_order_id_status_expires_at_idx" ON "payment_attempts"("order_id","status","expires_at");
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "payment_attempt_events" ("id" TEXT NOT NULL,"payment_attempt_id" TEXT NOT NULL,"provider_event_key" TEXT NOT NULL,"event_type" TEXT NOT NULL,"status" "PaymentStatus" NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "payment_attempt_events_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "payment_attempt_events_provider_event_key_key" ON "payment_attempt_events"("provider_event_key");
CREATE INDEX "payment_attempt_events_payment_attempt_id_created_at_idx" ON "payment_attempt_events"("payment_attempt_id","created_at");
ALTER TABLE "payment_attempt_events" ADD CONSTRAINT "payment_attempt_events_payment_attempt_id_fkey" FOREIGN KEY ("payment_attempt_id") REFERENCES "payment_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
