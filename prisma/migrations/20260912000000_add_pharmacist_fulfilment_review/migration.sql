ALTER TYPE "OrderFulfilmentStatus" ADD VALUE IF NOT EXISTS 'APPROVED_FOR_DISPENSING';
ALTER TYPE "OrderFulfilmentStatus" ADD VALUE IF NOT EXISTS 'CLARIFICATION_REQUIRED';
ALTER TYPE "OrderFulfilmentStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
ALTER TYPE "OrderFulfilmentStatus" ADD VALUE IF NOT EXISTS 'UNABLE_TO_FULFILL';
ALTER TABLE "order_fulfilments" ADD COLUMN "reviewed_by_user_id" TEXT, ADD COLUMN "reviewed_at" TIMESTAMP(3), ADD COLUMN "decision_note" TEXT, ADD COLUMN "patient_message" TEXT;
ALTER TABLE "order_allocations" ADD COLUMN "inventory_item_id" TEXT;
CREATE TYPE "RefundReviewStatus" AS ENUM ('PENDING_REVIEW','RESOLVED');
CREATE TABLE "refund_review_cases" ("id" TEXT NOT NULL,"fulfilment_id" TEXT NOT NULL,"order_id" TEXT NOT NULL,"amount_minor" INTEGER NOT NULL,"currency" TEXT NOT NULL,"status" "RefundReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',"reason" TEXT NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,CONSTRAINT "refund_review_cases_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "refund_review_cases_fulfilment_id_key" ON "refund_review_cases"("fulfilment_id"); CREATE INDEX "refund_review_cases_order_id_status_idx" ON "refund_review_cases"("order_id","status"); ALTER TABLE "refund_review_cases" ADD CONSTRAINT "refund_review_cases_fulfilment_id_fkey" FOREIGN KEY ("fulfilment_id") REFERENCES "order_fulfilments"("id") ON DELETE CASCADE;
