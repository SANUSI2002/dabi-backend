ALTER TABLE "delivery_assignments"
 ADD COLUMN "pickup_code_encrypted" TEXT,
 ADD COLUMN "pickup_code_expires_at" TIMESTAMP(3),
 ADD COLUMN "pickup_code_issued_at" TIMESTAMP(3),
 ADD COLUMN "pickup_code_attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("pickup_code_attempts" BETWEEN 0 AND 5),
 ADD COLUMN "pickup_code_locked_until" TIMESTAMP(3),
 ADD COLUMN "delivery_code_encrypted" TEXT,
 ADD COLUMN "delivery_code_expires_at" TIMESTAMP(3),
 ADD COLUMN "delivery_code_issued_at" TIMESTAMP(3),
 ADD COLUMN "delivery_code_attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("delivery_code_attempts" BETWEEN 0 AND 5),
 ADD COLUMN "delivery_code_locked_until" TIMESTAMP(3);
