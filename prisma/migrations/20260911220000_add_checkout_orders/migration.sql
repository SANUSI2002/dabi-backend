ALTER TYPE "ReservationStatus" ADD VALUE IF NOT EXISTS 'CONVERTED';
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'PAYMENT_FAILED', 'CANCELLED');
CREATE TYPE "OrderFulfilmentStatus" AS ENUM ('AWAITING_PAYMENT', 'AWAITING_PHARMACIST_REVIEW', 'CANCELLED');

CREATE TABLE "orders" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "reservation_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "pricing_config_version" INTEGER NOT NULL,
  "platform_fee_minor" INTEGER NOT NULL,
  "delivery_rate_per_km_minor" INTEGER NOT NULL,
  "subtotal_minor" INTEGER NOT NULL,
  "delivery_fee_minor" INTEGER NOT NULL,
  "total_payable_minor" INTEGER NOT NULL,
  "encrypted_delivery_details" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "orders_reference_key" ON "orders"("reference");
CREATE UNIQUE INDEX "orders_reservation_id_key" ON "orders"("reservation_id");
CREATE UNIQUE INDEX "orders_patient_id_idempotency_key_key" ON "orders"("patient_id", "idempotency_key");
CREATE INDEX "orders_patient_id_created_at_idx" ON "orders"("patient_id", "created_at");
ALTER TABLE "orders" ADD CONSTRAINT "orders_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "orders" ADD CONSTRAINT "orders_reservation_id_fkey" FOREIGN KEY ("reservation_id") REFERENCES "reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "order_fulfilments" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "pharmacy_id" TEXT NOT NULL,
  "status" "OrderFulfilmentStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
  "fulfilment_method" TEXT NOT NULL,
  "subtotal_minor" INTEGER NOT NULL,
  "delivery_fee_minor" INTEGER NOT NULL,
  "total_minor" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_fulfilments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_fulfilments_order_id_idx" ON "order_fulfilments"("order_id");
CREATE INDEX "order_fulfilments_pharmacy_id_status_idx" ON "order_fulfilments"("pharmacy_id", "status");
ALTER TABLE "order_fulfilments" ADD CONSTRAINT "order_fulfilments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "order_fulfilments" ADD CONSTRAINT "order_fulfilments_pharmacy_id_fkey" FOREIGN KEY ("pharmacy_id") REFERENCES "pharmacies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "order_allocations" (
  "id" TEXT NOT NULL,
  "fulfilment_id" TEXT NOT NULL,
  "reservation_allocation_id" TEXT NOT NULL,
  "prescription_item_id" TEXT NOT NULL,
  "medication_name" TEXT NOT NULL,
  "selected_quantity" INTEGER NOT NULL,
  "unit_price_minor" INTEGER NOT NULL,
  "line_total_minor" INTEGER NOT NULL,
  CONSTRAINT "order_allocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_allocations_fulfilment_id_idx" ON "order_allocations"("fulfilment_id");
CREATE INDEX "order_allocations_reservation_allocation_id_idx" ON "order_allocations"("reservation_allocation_id");
ALTER TABLE "order_allocations" ADD CONSTRAINT "order_allocations_fulfilment_id_fkey" FOREIGN KEY ("fulfilment_id") REFERENCES "order_fulfilments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
