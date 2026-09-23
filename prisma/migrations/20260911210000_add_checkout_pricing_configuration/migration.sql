CREATE TABLE "checkout_pricing_configurations" (
  "id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "platform_fee_minor" INTEGER NOT NULL DEFAULT 0,
  "delivery_rate_per_km_minor" INTEGER NOT NULL DEFAULT 60000,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "effective_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "checkout_pricing_configurations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "checkout_pricing_configurations_version_key"
  ON "checkout_pricing_configurations"("version");
CREATE INDEX "checkout_pricing_configurations_effective_at_idx"
  ON "checkout_pricing_configurations"("effective_at");

INSERT INTO "checkout_pricing_configurations" (
  "id", "version", "platform_fee_minor", "delivery_rate_per_km_minor", "currency"
) VALUES (
  '00000000-0000-4000-8000-000000000001', 1, 0, 60000, 'NGN'
);
