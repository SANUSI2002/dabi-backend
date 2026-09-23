ALTER TYPE "OrderFulfilmentStatus" ADD VALUE IF NOT EXISTS 'PREPARING';
ALTER TYPE "OrderFulfilmentStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_PICKUP';
ALTER TABLE "order_fulfilments" ADD COLUMN "inventory_finalized_at" TIMESTAMP(3);
