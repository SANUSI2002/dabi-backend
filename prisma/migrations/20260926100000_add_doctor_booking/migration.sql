-- CreateEnum
CREATE TYPE "DoctorConsultationType" AS ENUM ('VIRTUAL', 'IN_PERSON');

-- CreateEnum
CREATE TYPE "DoctorAppointmentStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'DECLINED', 'CANCELLED', 'COMPLETED');

-- AlterTable
ALTER TABLE "professional_profiles" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "consultation_fee_minor" INTEGER,
ADD COLUMN     "consultation_types" "DoctorConsultationType"[] DEFAULT ARRAY[]::"DoctorConsultationType"[],
ADD COLUMN     "practice_address" TEXT,
ADD COLUMN     "years_of_experience" INTEGER;

-- CreateTable
CREATE TABLE "doctor_availability_slots" (
    "id" TEXT NOT NULL,
    "doctor_profile_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "consultation_types" "DoctorConsultationType"[],
    "cancelled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doctor_availability_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_appointments" (
    "id" TEXT NOT NULL,
    "patient_id" TEXT NOT NULL,
    "dependent_id" TEXT,
    "doctor_profile_id" TEXT NOT NULL,
    "slot_id" TEXT NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "consultation_type" "DoctorConsultationType" NOT NULL,
    "reason" VARCHAR(500),
    "status" "DoctorAppointmentStatus" NOT NULL DEFAULT 'REQUESTED',
    "decision_reason" VARCHAR(300),
    "meeting_url" VARCHAR(500),
    "cancelled_by" VARCHAR(20),
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctor_appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "doctor_availability_slots_doctor_profile_id_starts_at_idx" ON "doctor_availability_slots"("doctor_profile_id", "starts_at");

-- CreateIndex
CREATE INDEX "doctor_appointments_patient_id_starts_at_idx" ON "doctor_appointments"("patient_id", "starts_at");

-- CreateIndex
CREATE INDEX "doctor_appointments_doctor_profile_id_status_starts_at_idx" ON "doctor_appointments"("doctor_profile_id", "status", "starts_at");

-- CreateIndex
CREATE INDEX "doctor_appointments_slot_id_idx" ON "doctor_appointments"("slot_id");

-- AddForeignKey
ALTER TABLE "doctor_availability_slots" ADD CONSTRAINT "doctor_availability_slots_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "professional_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_appointments" ADD CONSTRAINT "doctor_appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_appointments" ADD CONSTRAINT "doctor_appointments_dependent_id_fkey" FOREIGN KEY ("dependent_id") REFERENCES "dependent_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_appointments" ADD CONSTRAINT "doctor_appointments_doctor_profile_id_fkey" FOREIGN KEY ("doctor_profile_id") REFERENCES "professional_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_appointments" ADD CONSTRAINT "doctor_appointments_slot_id_fkey" FOREIGN KEY ("slot_id") REFERENCES "doctor_availability_slots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A slot can be held by at most one active (requested or confirmed) appointment. Declined,
-- cancelled and completed appointments release it. This is what makes double-booking impossible
-- even when two patients book the same slot at the same moment.
CREATE UNIQUE INDEX "doctor_appointments_active_slot_key"
  ON "doctor_appointments" ("slot_id")
  WHERE "status" IN ('REQUESTED', 'CONFIRMED');

ALTER TABLE "doctor_availability_slots"
  ADD CONSTRAINT "doctor_availability_slots_time_check" CHECK ("ends_at" > "starts_at");
ALTER TABLE "doctor_appointments"
  ADD CONSTRAINT "doctor_appointments_time_check" CHECK ("ends_at" > "starts_at");
