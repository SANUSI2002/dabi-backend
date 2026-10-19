-- Labour & delivery and the birth register (Maternal & Child Health, part 2).
-- A delivery is recorded once per baby; when the mother has an ongoing antenatal enrolment it is
-- linked and closed as DELIVERED in the same transaction, and gestational age comes from its LMP.
-- Live births can be notified (facility notification number from a per-year counter), registered
-- (the civil registration number issued by the National Population Commission is recorded, never
-- invented) and the certificate's issue recorded. Nothing is deleted.

CREATE TABLE "emr_deliveries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "pregnancy_id" TEXT,
  "booking_status" VARCHAR(12) NOT NULL,
  "delivered_at" TIMESTAMP(3) NOT NULL,
  "gestational_weeks" INTEGER NOT NULL,
  "mode" VARCHAR(20) NOT NULL,
  "mother_status" VARCHAR(10) NOT NULL,
  "blood_loss_ml" INTEGER NOT NULL,
  "complications" VARCHAR(500),
  "notes" VARCHAR(1000),
  "nhmis_indicators" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "baby_sex" VARCHAR(6) NOT NULL,
  "baby_status" VARCHAR(20) NOT NULL,
  "birth_weight_kg" DECIMAL(3, 2) NOT NULL,
  "apgar_1" INTEGER,
  "apgar_5" INTEGER,
  "breastfed_within_hour" BOOLEAN NOT NULL DEFAULT false,
  "conducted_by_user_id" TEXT NOT NULL,
  "recorded_by_user_id" TEXT NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "error_reason" VARCHAR(300),
  "errored_by_user_id" TEXT,
  "errored_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_deliveries_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_deliveries_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_deliveries_pregnancy_fkey" FOREIGN KEY ("organization_id", "pregnancy_id", "patient_id") REFERENCES "emr_pregnancies"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_deliveries_codes_check" CHECK (
    "booking_status" IN ('BOOKED', 'UNBOOKED', 'REFERRED_IN') AND
    "mode" IN ('SVD', 'ASSISTED_VACUUM', 'BREECH', 'CAESAREAN_REFERRED') AND
    "mother_status" IN ('ALIVE', 'DIED', 'REFERRED') AND
    "baby_sex" IN ('FEMALE', 'MALE') AND
    "baby_status" IN ('ALIVE', 'FRESH_STILLBIRTH', 'MACERATED_STILLBIRTH')
  ),
  CONSTRAINT "emr_deliveries_measures_check" CHECK (
    "gestational_weeks" BETWEEN 20 AND 45 AND "blood_loss_ml" BETWEEN 0 AND 6000 AND "birth_weight_kg" BETWEEN 0.3 AND 7 AND
    ("apgar_1" IS NULL OR "apgar_1" BETWEEN 0 AND 10) AND ("apgar_5" IS NULL OR "apgar_5" BETWEEN 0 AND 10) AND
    -- A live baby has both APGAR scores; a stillborn baby has none and was not breastfed.
    (("baby_status" = 'ALIVE') = ("apgar_1" IS NOT NULL AND "apgar_5" IS NOT NULL)) AND ("baby_status" = 'ALIVE' OR NOT "breastfed_within_hour")
  ),
  CONSTRAINT "emr_deliveries_status_check" CHECK ("status" IN ('ACTIVE', 'ENTERED_IN_ERROR')),
  CONSTRAINT "emr_deliveries_error_check" CHECK (("status" = 'ENTERED_IN_ERROR') = ("error_reason" IS NOT NULL AND "errored_by_user_id" IS NOT NULL AND "errored_at" IS NOT NULL))
);
CREATE INDEX "emr_deliveries_organization_id_delivered_at_id_idx" ON "emr_deliveries"("organization_id", "delivered_at", "id");
CREATE INDEX "emr_deliveries_patient_idx" ON "emr_deliveries"("organization_id", "patient_id", "delivered_at");

CREATE TABLE "emr_birth_registrations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "delivery_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "baby_name" VARCHAR(160),
  "father_name" VARCHAR(160),
  "informant_name" VARCHAR(160) NOT NULL,
  "informant_relation" VARCHAR(20) NOT NULL,
  "notification_number" VARCHAR(32) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'NOTIFIED',
  "notified_by_user_id" TEXT NOT NULL,
  "notified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "registration_number" VARCHAR(60),
  "registered_by_user_id" TEXT,
  "registered_at" TIMESTAMP(3),
  "certificate_issued_by_user_id" TEXT,
  "certificate_issued_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_birth_registrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_birth_registrations_delivery_key" UNIQUE ("organization_id", "delivery_id"),
  CONSTRAINT "emr_birth_registrations_number_key" UNIQUE ("organization_id", "notification_number"),
  CONSTRAINT "emr_birth_registrations_delivery_fkey" FOREIGN KEY ("organization_id", "delivery_id") REFERENCES "emr_deliveries"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_birth_registrations_patient_fkey" FOREIGN KEY ("organization_id", "patient_id") REFERENCES "emr_patients"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_birth_registrations_relation_check" CHECK ("informant_relation" IN ('MOTHER', 'FATHER', 'GRANDPARENT', 'GUARDIAN', 'HEALTH_WORKER')),
  CONSTRAINT "emr_birth_registrations_status_check" CHECK ("status" IN ('NOTIFIED', 'REGISTERED', 'CERTIFICATE_ISSUED')),
  -- Each step carries who and when, in order.
  CONSTRAINT "emr_birth_registrations_steps_check" CHECK (
    ("status" = 'NOTIFIED') = ("registration_number" IS NULL AND "registered_by_user_id" IS NULL AND "registered_at" IS NULL) AND
    ("status" = 'CERTIFICATE_ISSUED') = ("certificate_issued_by_user_id" IS NOT NULL AND "certificate_issued_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "emr_birth_registrations_registration_number_key" ON "emr_birth_registrations"("organization_id", "registration_number") WHERE "registration_number" IS NOT NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_deliveries', 'emr_birth_registrations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

-- No DELETE. A delivery changes only by being marked entered-in-error; a registration only moves
-- forward (the baby's name may be added until the birth is registered).
GRANT SELECT, INSERT ON "emr_deliveries" TO sabi_emr_app;
GRANT UPDATE ("status", "error_reason", "errored_by_user_id", "errored_at") ON "emr_deliveries" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_birth_registrations" TO sabi_emr_app;
GRANT UPDATE ("baby_name", "status", "registration_number", "registered_by_user_id", "registered_at", "certificate_issued_by_user_id", "certificate_issued_at", "version", "updated_at") ON "emr_birth_registrations" TO sabi_emr_app;

INSERT INTO "access_permissions" ("code", "description") VALUES
  ('delivery.read', 'View delivery records and the birth register'),
  ('delivery.record', 'Record deliveries'),
  ('birth.register', 'Notify and register births and record certificate issue')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('DOCTOR', 'delivery.read'), ('DOCTOR', 'delivery.record'), ('DOCTOR', 'birth.register'),
  ('NURSE', 'delivery.read'), ('NURSE', 'delivery.record'), ('NURSE', 'birth.register'),
  ('HOSPITAL_ADMIN', 'delivery.read'), ('HOSPITAL_ADMIN', 'birth.register')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
