-- EMR admissions: wards, beds, admissions with bed history, and the medication administration
-- record (MAR). Invariants enforced by the database:
--   one current admission per bed, per patient, and per visit; a bed always belongs to the ward
--   recorded with it; bed history and MAR entries are append-only (only closing/error columns
--   may be set, once); tenants isolated by RLS and composite foreign keys.
-- All objects are new; nothing here locks an existing table.

CREATE TYPE "EmrBedStatus" AS ENUM ('AVAILABLE', 'OCCUPIED', 'CLEANING', 'OUT_OF_SERVICE');
CREATE TYPE "EmrAdmissionStatus" AS ENUM ('ADMITTED', 'DISCHARGED', 'CANCELLED');
CREATE TYPE "EmrDischargeDisposition" AS ENUM ('HOME', 'TRANSFERRED_OUT', 'AGAINST_MEDICAL_ADVICE', 'DECEASED', 'OTHER');
CREATE TYPE "EmrAdministrationStatus" AS ENUM ('GIVEN', 'HELD', 'REFUSED', 'MISSED');

-- ---------------------------------------------------------------------------------------------
-- Wards and beds
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_wards" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "gender_restriction" TEXT NOT NULL DEFAULT 'ANY',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_wards_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_wards_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_wards_organization_id_code_key" UNIQUE ("organization_id", "code"),
  CONSTRAINT "emr_wards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "identity_organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_wards_kind_check" CHECK ("kind" IN ('GENERAL', 'SURGICAL', 'MATERNITY', 'PAEDIATRIC', 'ICU', 'HDU', 'ISOLATION', 'PRIVATE', 'OTHER')),
  CONSTRAINT "emr_wards_gender_check" CHECK ("gender_restriction" IN ('ANY', 'FEMALE', 'MALE'))
);

CREATE TABLE "emr_beds" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "ward_id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "status" "EmrBedStatus" NOT NULL DEFAULT 'AVAILABLE',
  "status_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_beds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_beds_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_beds_organization_id_ward_id_id_key" UNIQUE ("organization_id", "ward_id", "id"),
  CONSTRAINT "emr_beds_organization_id_ward_id_code_key" UNIQUE ("organization_id", "ward_id", "code"),
  CONSTRAINT "emr_beds_ward_fkey" FOREIGN KEY ("organization_id", "ward_id") REFERENCES "emr_wards"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_beds_out_of_service_check" CHECK ("status" <> 'OUT_OF_SERVICE' OR "status_reason" IS NOT NULL)
);
CREATE INDEX "emr_beds_organization_id_ward_status_idx" ON "emr_beds"("organization_id", "ward_id", "status");

-- ---------------------------------------------------------------------------------------------
-- Admissions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_admissions" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "encounter_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "status" "EmrAdmissionStatus" NOT NULL DEFAULT 'ADMITTED',
  "ward_id" TEXT NOT NULL,
  "bed_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "admitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "admitted_by_user_id" TEXT NOT NULL,
  "attending_user_id" TEXT,
  "expected_discharge_date" DATE,
  "discharged_at" TIMESTAMP(3),
  "discharged_by_user_id" TEXT,
  "discharge_disposition" "EmrDischargeDisposition",
  "discharge_summary" TEXT,
  "cancelled_at" TIMESTAMP(3),
  "cancelled_by_user_id" TEXT,
  "cancellation_reason" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_admissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_admissions_organization_id_id_key" UNIQUE ("organization_id", "id"),
  CONSTRAINT "emr_admissions_organization_id_id_patient_key" UNIQUE ("organization_id", "id", "patient_id"),
  CONSTRAINT "emr_admissions_encounter_fkey" FOREIGN KEY ("organization_id", "encounter_id", "patient_id") REFERENCES "emr_encounters"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- Composite: the bed must belong to the recorded ward.
  CONSTRAINT "emr_admissions_bed_fkey" FOREIGN KEY ("organization_id", "ward_id", "bed_id") REFERENCES "emr_beds"("organization_id", "ward_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_admissions_attending_fkey" FOREIGN KEY ("attending_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "emr_admissions_discharged_check" CHECK ("status" <> 'DISCHARGED' OR ("discharged_at" IS NOT NULL AND "discharge_disposition" IS NOT NULL AND "discharge_summary" IS NOT NULL)),
  CONSTRAINT "emr_admissions_cancelled_check" CHECK ("status" <> 'CANCELLED' OR "cancellation_reason" IS NOT NULL),
  CONSTRAINT "emr_admissions_timeline_check" CHECK ("discharged_at" IS NULL OR "discharged_at" >= "admitted_at")
);
CREATE UNIQUE INDEX "emr_admissions_one_per_bed_key" ON "emr_admissions"("organization_id", "bed_id") WHERE "status" = 'ADMITTED';
CREATE UNIQUE INDEX "emr_admissions_one_per_patient_key" ON "emr_admissions"("organization_id", "patient_id") WHERE "status" = 'ADMITTED';
CREATE UNIQUE INDEX "emr_admissions_one_per_encounter_key" ON "emr_admissions"("organization_id", "encounter_id") WHERE "status" <> 'CANCELLED';
CREATE INDEX "emr_admissions_organization_id_census_idx" ON "emr_admissions"("organization_id", "status", "ward_id", "admitted_at");
CREATE INDEX "emr_admissions_organization_id_created_at_idx" ON "emr_admissions"("organization_id", "created_at" DESC, "id" DESC);
CREATE INDEX "emr_admissions_organization_id_patient_idx" ON "emr_admissions"("organization_id", "patient_id", "admitted_at" DESC);

-- Bed history: one row per stay in a bed. Only "ended_at" may be set, and only once.
CREATE TABLE "emr_bed_assignments" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "admission_id" TEXT NOT NULL,
  "ward_id" TEXT NOT NULL,
  "bed_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "note" TEXT,
  "assigned_by_user_id" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  CONSTRAINT "emr_bed_assignments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_bed_assignments_admission_fkey" FOREIGN KEY ("organization_id", "admission_id") REFERENCES "emr_admissions"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_bed_assignments_bed_fkey" FOREIGN KEY ("organization_id", "ward_id", "bed_id") REFERENCES "emr_beds"("organization_id", "ward_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_bed_assignments_reason_check" CHECK ("reason" IN ('ADMISSION', 'TRANSFER')),
  CONSTRAINT "emr_bed_assignments_timeline_check" CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at")
);
CREATE UNIQUE INDEX "emr_bed_assignments_one_open_key" ON "emr_bed_assignments"("organization_id", "admission_id") WHERE "ended_at" IS NULL;
CREATE INDEX "emr_bed_assignments_organization_id_admission_idx" ON "emr_bed_assignments"("organization_id", "admission_id", "started_at");

CREATE OR REPLACE FUNCTION emr_bed_assignments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'emr_bed_assignments is append-only';
  END IF;
  IF OLD."ended_at" IS NOT NULL
     OR NEW."admission_id" <> OLD."admission_id" OR NEW."bed_id" <> OLD."bed_id" OR NEW."ward_id" <> OLD."ward_id"
     OR NEW."started_at" <> OLD."started_at" OR NEW."reason" <> OLD."reason" THEN
    RAISE EXCEPTION 'A bed assignment can only be closed, once';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "emr_bed_assignments_guard" BEFORE UPDATE OR DELETE ON "emr_bed_assignments"
  FOR EACH ROW EXECUTE FUNCTION emr_bed_assignments_guard();

-- ---------------------------------------------------------------------------------------------
-- Medication administration record (MAR). Never edited: corrections are marked ENTERED_IN_ERROR.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE "emr_medication_administrations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "admission_id" TEXT NOT NULL,
  "patient_id" TEXT NOT NULL,
  "prescription_item_id" TEXT NOT NULL,
  "status" "EmrAdministrationStatus" NOT NULL,
  "dose" NUMERIC(12, 4),
  "dose_unit" TEXT,
  "route" TEXT,
  "administered_at" TIMESTAMP(3) NOT NULL,
  "administered_by_user_id" TEXT NOT NULL,
  "witness_user_id" TEXT,
  "reason" TEXT,
  "entry_status" "EmrEntryStatus" NOT NULL DEFAULT 'ACTIVE',
  "error_reason" TEXT,
  "errored_by_user_id" TEXT,
  "errored_at" TIMESTAMP(3),
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "emr_medication_administrations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "emr_medication_administrations_admission_fkey" FOREIGN KEY ("organization_id", "admission_id", "patient_id") REFERENCES "emr_admissions"("organization_id", "id", "patient_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_medication_administrations_item_fkey" FOREIGN KEY ("organization_id", "prescription_item_id") REFERENCES "emr_prescription_items"("organization_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "emr_medication_administrations_given_check" CHECK (
    ("status" = 'GIVEN' AND "dose" > 0 AND "dose_unit" IS NOT NULL AND "route" IS NOT NULL)
    OR ("status" <> 'GIVEN' AND "reason" IS NOT NULL)),
  CONSTRAINT "emr_medication_administrations_witness_check" CHECK ("witness_user_id" IS NULL OR "witness_user_id" <> "administered_by_user_id"),
  CONSTRAINT "emr_medication_administrations_error_check" CHECK ("entry_status" = 'ACTIVE' OR "error_reason" IS NOT NULL)
);
CREATE INDEX "emr_medication_administrations_organization_id_admission_idx" ON "emr_medication_administrations"("organization_id", "admission_id", "administered_at");
CREATE INDEX "emr_medication_administrations_organization_id_item_idx" ON "emr_medication_administrations"("organization_id", "prescription_item_id", "administered_at");

-- ---------------------------------------------------------------------------------------------
-- Row-level security and least-privilege grants
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['emr_wards', 'emr_beds', 'emr_admissions', 'emr_bed_assignments', 'emr_medication_administrations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING ("organization_id" = emr_current_organization()) WITH CHECK ("organization_id" = emr_current_organization())', t || '_tenant', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON "emr_wards" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_beds" TO sabi_emr_app;
GRANT SELECT, INSERT, UPDATE ON "emr_admissions" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_bed_assignments" TO sabi_emr_app;
GRANT UPDATE ("ended_at") ON "emr_bed_assignments" TO sabi_emr_app;
GRANT SELECT, INSERT ON "emr_medication_administrations" TO sabi_emr_app;
GRANT UPDATE ("entry_status", "error_reason", "errored_by_user_id", "errored_at") ON "emr_medication_administrations" TO sabi_emr_app;

-- ---------------------------------------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------------------------------------
INSERT INTO "access_permissions" ("code", "description") VALUES
  ('ward.manage', 'Create and edit wards and beds'),
  ('bed.manage', 'Update bed status (cleaning, out of service)'),
  ('admission.read', 'View admissions and the bed census'),
  ('admission.create', 'Admit patients (and cancel an admission entered in error)'),
  ('admission.transfer', 'Transfer admitted patients between beds'),
  ('admission.discharge', 'Discharge admitted patients'),
  ('medication.administer', 'Record medication administration (MAR)')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "access_role_permissions" ("role_code", "permission_code") VALUES
  ('HOSPITAL_ADMIN', 'ward.manage'),
  ('HOSPITAL_ADMIN', 'bed.manage'),
  ('HOSPITAL_ADMIN', 'admission.read'),
  ('DOCTOR', 'admission.read'),
  ('DOCTOR', 'admission.create'),
  ('DOCTOR', 'admission.transfer'),
  ('DOCTOR', 'admission.discharge'),
  ('DOCTOR', 'medication.administer'),
  ('NURSE', 'admission.read'),
  ('NURSE', 'admission.transfer'),
  ('NURSE', 'bed.manage'),
  ('NURSE', 'medication.administer'),
  ('RECEPTIONIST', 'admission.read')
ON CONFLICT ("role_code", "permission_code") DO NOTHING;
