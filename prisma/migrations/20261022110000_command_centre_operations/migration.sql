-- Command Centre operations: refund decisions (maker-checker, provider evidence), pharmacy
-- settlements, support cases and incidents, time-limited emergency access, and a receipt log for
-- payment-provider webhooks. Money is integer kobo throughout.

-- ---------------------------------------------------------------------------------------------
-- Refunds. A case opened when a paid fulfilment cannot proceed is proposed by one finance user and
-- approved by another, then submitted to the payment provider. It is only REFUNDED on provider
-- evidence (a refund webhook, or a provider reference recorded with a note by a second person).
-- ---------------------------------------------------------------------------------------------
ALTER TYPE "RefundReviewStatus" ADD VALUE IF NOT EXISTS 'PROPOSED';
ALTER TYPE "RefundReviewStatus" ADD VALUE IF NOT EXISTS 'APPROVED';
ALTER TYPE "RefundReviewStatus" ADD VALUE IF NOT EXISTS 'DECLINED';
ALTER TYPE "RefundReviewStatus" ADD VALUE IF NOT EXISTS 'SUBMITTED';
ALTER TYPE "RefundReviewStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';
ALTER TYPE "RefundReviewStatus" ADD VALUE IF NOT EXISTS 'FAILED';

ALTER TABLE "refund_review_cases"
  ADD COLUMN "proposed_by_user_id" TEXT,
  ADD COLUMN "proposed_at" TIMESTAMP(3),
  ADD COLUMN "proposal_note" VARCHAR(500),
  ADD COLUMN "decided_by_user_id" TEXT,
  ADD COLUMN "decided_at" TIMESTAMP(3),
  ADD COLUMN "decision_note" VARCHAR(500),
  ADD COLUMN "submitted_at" TIMESTAMP(3),
  ADD COLUMN "provider" VARCHAR(32),
  ADD COLUMN "provider_refund_reference" VARCHAR(120),
  ADD COLUMN "provider_status" VARCHAR(32),
  ADD COLUMN "failure_reason" VARCHAR(300),
  ADD COLUMN "evidence_note" VARCHAR(500),
  ADD COLUMN "evidence_recorded_by_user_id" TEXT,
  ADD COLUMN "refunded_at" TIMESTAMP(3),
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "refund_review_cases_provider_refund_reference_key" ON "refund_review_cases" ("provider_refund_reference");
CREATE INDEX "refund_review_cases_status_created_at_idx" ON "refund_review_cases" ("status", "created_at" DESC);

-- ---------------------------------------------------------------------------------------------
-- Payment webhooks: one row per delivery received, whatever happened to it (for webhook health and
-- reconciliation). No payload, no secrets: just the event type, reference and outcome.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "payment_webhook_receipts" (
  "id" TEXT NOT NULL,
  "provider" VARCHAR(32) NOT NULL,
  "event_type" VARCHAR(64),
  "reference" VARCHAR(120),
  "event_key" CHAR(64),
  "outcome" VARCHAR(24) NOT NULL,
  "detail" VARCHAR(200),
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_webhook_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_webhook_receipts_outcome_check" CHECK ("outcome" IN ('APPLIED', 'DUPLICATE', 'IGNORED', 'REJECTED_SIGNATURE', 'REJECTED_INVALID', 'ERROR'))
);
CREATE INDEX "payment_webhook_receipts_received_at_idx" ON "payment_webhook_receipts" ("received_at" DESC);
CREATE INDEX "payment_webhook_receipts_outcome_received_at_idx" ON "payment_webhook_receipts" ("outcome", "received_at" DESC);
CREATE INDEX "payment_webhook_receipts_reference_idx" ON "payment_webhook_receipts" ("reference");

-- ---------------------------------------------------------------------------------------------
-- Pharmacy settlements: what Sabi owes a pharmacy for a period (completed fulfilments, less
-- commission). Prepared by one finance user, approved by another; payment is recorded with the bank
-- transfer reference (Sabi has no payout provider connected). A fulfilment is settled at most once.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "pharmacy_settlements" (
  "id" TEXT NOT NULL,
  "reference" VARCHAR(40) NOT NULL,
  "pharmacy_id" TEXT NOT NULL,
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "currency" VARCHAR(3) NOT NULL DEFAULT 'NGN',
  "fulfilment_count" INTEGER NOT NULL,
  "gross_minor" INTEGER NOT NULL,
  "commission_minor" INTEGER NOT NULL,
  "net_payable_minor" INTEGER NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  "idempotency_key" VARCHAR(128) NOT NULL,
  "prepared_by_user_id" TEXT NOT NULL,
  "approved_by_user_id" TEXT,
  "approved_at" TIMESTAMP(3),
  "paid_by_user_id" TEXT,
  "paid_at" TIMESTAMP(3),
  "payout_reference" VARCHAR(120),
  "payout_note" VARCHAR(500),
  "cancelled_by_user_id" TEXT,
  "cancelled_at" TIMESTAMP(3),
  "cancel_reason" VARCHAR(500),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pharmacy_settlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_settlements_pharmacy_id_fkey" FOREIGN KEY ("pharmacy_id") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_settlements_status_check" CHECK ("status" IN ('DRAFT', 'APPROVED', 'PAID', 'CANCELLED')),
  CONSTRAINT "pharmacy_settlements_amounts_check" CHECK ("gross_minor" >= 0 AND "commission_minor" >= 0 AND "net_payable_minor" = "gross_minor" - "commission_minor"),
  CONSTRAINT "pharmacy_settlements_period_check" CHECK ("period_end" > "period_start"),
  CONSTRAINT "pharmacy_settlements_paid_check" CHECK ("status" <> 'PAID' OR ("payout_reference" IS NOT NULL AND "paid_at" IS NOT NULL)),
  CONSTRAINT "pharmacy_settlements_four_eyes_check" CHECK ("approved_by_user_id" IS NULL OR "approved_by_user_id" <> "prepared_by_user_id")
);
CREATE UNIQUE INDEX "pharmacy_settlements_reference_key" ON "pharmacy_settlements" ("reference");
CREATE UNIQUE INDEX "pharmacy_settlements_idempotency_key_key" ON "pharmacy_settlements" ("idempotency_key");
CREATE INDEX "pharmacy_settlements_pharmacy_id_created_at_idx" ON "pharmacy_settlements" ("pharmacy_id", "created_at" DESC);
CREATE INDEX "pharmacy_settlements_status_created_at_idx" ON "pharmacy_settlements" ("status", "created_at" DESC);

CREATE TABLE "pharmacy_settlement_items" (
  "id" TEXT NOT NULL,
  "settlement_id" TEXT NOT NULL,
  "fulfilment_id" TEXT NOT NULL,
  "gross_minor" INTEGER NOT NULL,
  "commission_minor" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "pharmacy_settlement_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pharmacy_settlement_items_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "pharmacy_settlements"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "pharmacy_settlement_items_fulfilment_id_fkey" FOREIGN KEY ("fulfilment_id") REFERENCES "order_fulfilments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "pharmacy_settlement_items_settlement_id_idx" ON "pharmacy_settlement_items" ("settlement_id");
-- A fulfilment can be on one live settlement only (a cancelled settlement releases its items).
CREATE UNIQUE INDEX "pharmacy_settlement_items_active_fulfilment_key" ON "pharmacy_settlement_items" ("fulfilment_id") WHERE "active";

-- ---------------------------------------------------------------------------------------------
-- Support cases and incidents (one queue, two kinds), with an append-only event history.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "ops_cases" (
  "id" TEXT NOT NULL,
  "reference" VARCHAR(24) NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "category" VARCHAR(32) NOT NULL,
  "priority" VARCHAR(8) NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  "title" VARCHAR(160) NOT NULL,
  "subject_user_id" TEXT,
  "order_id" TEXT,
  "pharmacy_id" TEXT,
  "professional_profile_id" TEXT,
  "assignee_user_id" TEXT,
  "created_by_user_id" TEXT NOT NULL,
  "due_at" TIMESTAMP(3),
  "resolved_at" TIMESTAMP(3),
  "resolution" VARCHAR(1000),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ops_cases_kind_check" CHECK ("kind" IN ('SUPPORT', 'INCIDENT')),
  CONSTRAINT "ops_cases_priority_check" CHECK ("priority" IN ('P1', 'P2', 'P3', 'P4')),
  CONSTRAINT "ops_cases_status_check" CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED')),
  CONSTRAINT "ops_cases_resolution_check" CHECK ("status" NOT IN ('RESOLVED', 'CLOSED') OR "resolution" IS NOT NULL)
);
CREATE UNIQUE INDEX "ops_cases_reference_key" ON "ops_cases" ("reference");
CREATE INDEX "ops_cases_status_priority_created_at_idx" ON "ops_cases" ("status", "priority", "created_at" DESC);
CREATE INDEX "ops_cases_kind_created_at_idx" ON "ops_cases" ("kind", "created_at" DESC);
CREATE INDEX "ops_cases_subject_user_id_idx" ON "ops_cases" ("subject_user_id");
CREATE INDEX "ops_cases_order_id_idx" ON "ops_cases" ("order_id");
CREATE INDEX "ops_cases_assignee_user_id_status_idx" ON "ops_cases" ("assignee_user_id", "status");

CREATE TABLE "ops_case_events" (
  "id" TEXT NOT NULL,
  "case_id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "body" VARCHAR(2000),
  "from_status" VARCHAR(16),
  "to_status" VARCHAR(16),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ops_case_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ops_case_events_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "ops_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ops_case_events_kind_check" CHECK ("kind" IN ('CREATED', 'NOTE', 'STATUS', 'ASSIGNED', 'PRIORITY'))
);
CREATE INDEX "ops_case_events_case_id_created_at_idx" ON "ops_case_events" ("case_id", "created_at");
CREATE OR REPLACE FUNCTION ops_case_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ops_case_events is append-only';
END $$;
CREATE TRIGGER "ops_case_events_no_change" BEFORE UPDATE OR DELETE ON "ops_case_events"
  FOR EACH ROW EXECUTE FUNCTION ops_case_events_append_only();

-- ---------------------------------------------------------------------------------------------
-- Emergency ("break-glass") access: a platform user without clinical read permission may open one
-- patient's health information for a short, stated window. Every grant is reviewed afterwards.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emergency_access_grants" (
  "id" TEXT NOT NULL,
  "actor_user_id" TEXT NOT NULL,
  "subject_user_id" TEXT NOT NULL,
  "reason" VARCHAR(500) NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3),
  "reviewed_by_user_id" TEXT,
  "reviewed_at" TIMESTAMP(3),
  "review_outcome" VARCHAR(16),
  "review_note" VARCHAR(500),
  CONSTRAINT "emergency_access_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emergency_access_grants_window_check" CHECK ("expires_at" > "started_at" AND "expires_at" <= "started_at" + INTERVAL '60 minutes'),
  CONSTRAINT "emergency_access_grants_review_check" CHECK ("review_outcome" IS NULL OR "review_outcome" IN ('APPROPRIATE', 'INAPPROPRIATE')),
  CONSTRAINT "emergency_access_grants_reviewer_check" CHECK ("reviewed_by_user_id" IS NULL OR "reviewed_by_user_id" <> "actor_user_id")
);
CREATE INDEX "emergency_access_grants_actor_subject_expires_idx" ON "emergency_access_grants" ("actor_user_id", "subject_user_id", "expires_at" DESC);
CREATE INDEX "emergency_access_grants_reviewed_at_started_at_idx" ON "emergency_access_grants" ("reviewed_at", "started_at" DESC);

-- Support staff may need a patient's health information in an emergency (e.g. a patient calling
-- in distress); they get break-glass access, which is time-limited and reviewed, not standing access.
INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('SABI_SUPPORT', 'platform.emergency.access')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
