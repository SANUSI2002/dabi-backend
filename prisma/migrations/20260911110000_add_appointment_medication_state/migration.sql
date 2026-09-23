-- Additive rollout: all existing appointments become scheduled and existing
-- medication rows receive a timestamp at migration time.
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'COMPLETED');

ALTER TABLE "Appointment"
  ADD COLUMN "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
  ADD COLUMN "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "Medication"
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
