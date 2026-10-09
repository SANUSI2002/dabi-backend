-- Waitlists for products that are not open yet (first: Sabi AI). Contact details only — never health
-- information. One entry per product and email address; joining again just updates the details.
CREATE TABLE "waitlist_signups" (
    "id" TEXT NOT NULL,
    "product" VARCHAR(32) NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "full_name" VARCHAR(120),
    "role" VARCHAR(32) NOT NULL,
    "organisation" VARCHAR(160),
    "consented_at" TIMESTAMP(3) NOT NULL,
    "source" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waitlist_signups_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "waitlist_signups_product_check" CHECK ("product" IN ('SABI_AI')),
    CONSTRAINT "waitlist_signups_role_check" CHECK ("role" IN ('PROFESSIONAL', 'PATIENT', 'CAREGIVER', 'ORGANISATION', 'OTHER'))
);
CREATE UNIQUE INDEX "waitlist_signups_product_email_key" ON "waitlist_signups"("product", "email");
