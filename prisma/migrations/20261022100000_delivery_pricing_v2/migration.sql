-- Delivery pricing v2: a versioned rule set with explicit calculation order (see
-- src/modules/checkout-pricing/delivery-pricing.js). Every new column defaults to the behaviour
-- the platform already had (exact straight-line distance × rate per km, nothing else), so
-- existing versions and orders keep meaning exactly what they meant.

ALTER TABLE "checkout_pricing_configurations"
  ADD COLUMN "base_fee_minor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "included_distance_km" NUMERIC(8,3) NOT NULL DEFAULT 0,
  ADD COLUMN "minimum_fee_minor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maximum_fee_minor" INTEGER,
  ADD COLUMN "max_distance_km" NUMERIC(8,3),
  ADD COLUMN "distance_method" VARCHAR(16) NOT NULL DEFAULT 'STRAIGHT_LINE',
  ADD COLUMN "road_fallback_to_straight_line" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "distance_rounding" VARCHAR(16) NOT NULL DEFAULT 'EXACT',
  ADD COLUMN "fee_rounding_minor" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "bands" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "zones" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "restrict_to_zones" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "free_delivery_threshold_minor" INTEGER,
  ADD COLUMN "small_order_threshold_minor" INTEGER,
  ADD COLUMN "small_order_fee_minor" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "surcharges" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "quote_ttl_minutes" INTEGER NOT NULL DEFAULT 15,
  ADD COLUMN "change_reason" VARCHAR(500),
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "cancelled_by_user_id" TEXT,
  ADD CONSTRAINT "checkout_pricing_amounts_check" CHECK (
    "platform_fee_minor" >= 0 AND "delivery_rate_per_km_minor" >= 0 AND "base_fee_minor" >= 0 AND "minimum_fee_minor" >= 0
    AND ("maximum_fee_minor" IS NULL OR "maximum_fee_minor" >= "minimum_fee_minor")
    AND "included_distance_km" >= 0 AND ("max_distance_km" IS NULL OR "max_distance_km" > 0)
    AND "fee_rounding_minor" BETWEEN 1 AND 100000 AND "small_order_fee_minor" >= 0
    AND ("free_delivery_threshold_minor" IS NULL OR "free_delivery_threshold_minor" > 0)
    AND ("small_order_threshold_minor" IS NULL OR "small_order_threshold_minor" > 0)
    AND "quote_ttl_minutes" BETWEEN 1 AND 1440
  ),
  ADD CONSTRAINT "checkout_pricing_method_check" CHECK ("distance_method" IN ('STRAIGHT_LINE', 'ROAD')),
  ADD CONSTRAINT "checkout_pricing_rounding_check" CHECK ("distance_rounding" IN ('EXACT', 'UP_0_1_KM', 'UP_1_KM', 'NEAREST_0_1_KM')),
  ADD CONSTRAINT "checkout_pricing_shapes_check" CHECK (
    jsonb_typeof("bands") = 'array' AND jsonb_typeof("zones") = 'array' AND jsonb_typeof("surcharges") = 'array'
  );

CREATE INDEX IF NOT EXISTS "checkout_pricing_configurations_active_idx"
  ON "checkout_pricing_configurations" ("effective_at" DESC, "version" DESC) WHERE "cancelled_at" IS NULL;

-- The itemised delivery quote each fulfilment was charged (lines, distance, method, version).
-- Written once at order creation; later rate changes never touch it.
ALTER TABLE "order_fulfilments" ADD COLUMN "delivery_quote" JSONB;
