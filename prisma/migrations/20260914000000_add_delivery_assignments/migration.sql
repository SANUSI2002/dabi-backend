-- CreateEnum
CREATE TYPE "DeliveryAssignmentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'COMPLETED');

-- AlterEnum
ALTER TYPE "UserRoleType" ADD VALUE 'DELIVERY_PARTNER';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OrderFulfilmentStatus" ADD VALUE 'PICKED_UP';
ALTER TYPE "OrderFulfilmentStatus" ADD VALUE 'OUT_FOR_DELIVERY';
ALTER TYPE "OrderFulfilmentStatus" ADD VALUE 'DELIVERED';

-- CreateTable
CREATE TABLE "delivery_partners" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "configured_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_partners_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_assignments" (
    "id" TEXT NOT NULL,
    "fulfilment_id" TEXT NOT NULL,
    "partner_id" TEXT NOT NULL,
    "assigned_by_user_id" TEXT NOT NULL,
    "status" "DeliveryAssignmentStatus" NOT NULL DEFAULT 'PENDING',
    "rejection_reason" VARCHAR(300),
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),
    "picked_up_at" TIMESTAMP(3),
    "out_for_delivery_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "delivery_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_tracking_points" (
    "id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_tracking_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "delivery_partners_user_id_key" ON "delivery_partners"("user_id");

-- CreateIndex
CREATE INDEX "delivery_partners_is_active_idx" ON "delivery_partners"("is_active");

-- CreateIndex
CREATE INDEX "delivery_assignments_partner_id_status_assigned_at_idx" ON "delivery_assignments"("partner_id", "status", "assigned_at");

-- CreateIndex
CREATE INDEX "delivery_assignments_fulfilment_id_assigned_at_idx" ON "delivery_assignments"("fulfilment_id", "assigned_at");

-- CreateIndex
CREATE INDEX "delivery_tracking_points_assignment_id_recorded_at_idx" ON "delivery_tracking_points"("assignment_id", "recorded_at");

-- AddForeignKey
ALTER TABLE "delivery_partners" ADD CONSTRAINT "delivery_partners_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_assignments" ADD CONSTRAINT "delivery_assignments_fulfilment_id_fkey" FOREIGN KEY ("fulfilment_id") REFERENCES "order_fulfilments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_assignments" ADD CONSTRAINT "delivery_assignments_partner_id_fkey" FOREIGN KEY ("partner_id") REFERENCES "delivery_partners"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_tracking_points" ADD CONSTRAINT "delivery_tracking_points_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "delivery_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one live/completed assignment per fulfilment; rejected attempts remain history.
CREATE UNIQUE INDEX "delivery_assignments_one_current_per_fulfilment"
ON "delivery_assignments" ("fulfilment_id") WHERE "status" <> 'REJECTED';
ALTER TABLE "delivery_tracking_points"
  ADD CONSTRAINT "delivery_tracking_latitude_range" CHECK (latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT "delivery_tracking_longitude_range" CHECK (longitude BETWEEN -180 AND 180);
