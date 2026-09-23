ALTER TABLE "pharmacies" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "pharmacies" ADD COLUMN "longitude" DOUBLE PRECISION;
CREATE TABLE "pharmacy_inventory_items" (
  "id" TEXT NOT NULL, "pharmacy_id" TEXT NOT NULL, "medication_name" TEXT NOT NULL, "generic_name" TEXT,
  "available_quantity" INTEGER NOT NULL DEFAULT 0, "unit_price_minor" INTEGER NOT NULL, "currency" TEXT NOT NULL DEFAULT 'NGN',
  "is_active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "pharmacy_inventory_items_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "pharmacy_inventory_items_pharmacy_id_is_active_idx" ON "pharmacy_inventory_items"("pharmacy_id", "is_active");
ALTER TABLE "pharmacy_inventory_items" ADD CONSTRAINT "pharmacy_inventory_items_pharmacy_id_fkey" FOREIGN KEY ("pharmacy_id") REFERENCES "pharmacies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
