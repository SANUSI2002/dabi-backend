/*
  Warnings:

  - A unique constraint covering the columns `[patient_id]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `password` to the `users` table without a default value. This is not possible if the table is not empty.
  - Added the required column `patient_id` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "emergency_access_permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "two_factor_auth" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "dob" DATE,
ADD COLUMN     "password" TEXT NOT NULL,
ADD COLUMN     "patient_id" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "health_metrics" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "health_score" INTEGER NOT NULL DEFAULT 0,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "health_metrics_user_id_idx" ON "health_metrics"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_patient_id_key" ON "users"("patient_id");

-- AddForeignKey
ALTER TABLE "health_metrics" ADD CONSTRAINT "health_metrics_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
